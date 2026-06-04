# GitHub PR 자동 리뷰 봇 — 구현 스펙

> gemini-code-assist 처럼 GitHub App으로 설치되어, PR이 열리면 diff를 읽고
> OpenAI 호환 LLM으로 리뷰를 생성해 **요약 + 인라인 코멘트**(GitHub Reviews API)로 달아주는 봇.

---

## 1. 목표 / 범위

- **1차 목표**: 내 organization 대부분의 repo에 도입.
- **2차(미확정)**: 외부 organization까지 서비스 확장 → 그래서 GitHub App 방식 채택(설치 한 번으로 org 전체/신규 repo 자동 적용, 외부 확장 경로 보존).
- **결과물 언어**: 한국어.
- **리뷰 초점**: 버그/로직 오류, 보안 취약점, 성능/효율. (순수 스타일·취향 지적은 프롬프트로 배제)

---

## 2. 아키텍처

```
GitHub (org repos)
   │  webhook (pull_request, issue_comment)
   ▼
[Node.js 앱 (Docker)]
        │
        ┌──────────────────┼───────────────────┐
        ▼                  ▼                   ▼
GitHub REST API      OpenAI호환 LLM        (로그)
(diff 조회 /          (tool calling으로
 Reviews API 게시)     구조화 리뷰 생성)
```

- **형태**: GitHub App + VPS에서 상시 구동되는 webhook 수신 서버.
- **스택**: Node.js + Octokit (`@octokit/app`, `@octokit/webhooks`) + OpenAI SDK(`baseURL` 커스텀).
- **상태**: **Stateless**. DB 없음. (재실행은 "누적" 방식이라 이전 리뷰 추적 불필요)
- **배포**: Docker 컨테이너, 포트 직접 노출.

---

## 3. 트리거 동작

| 이벤트 | 동작 |
|---|---|
| `pull_request` `opened` | 전체 리뷰 1회 |
| `pull_request` `reopened` | 전체 리뷰 1회 |
| `issue_comment` `created` 이면서 본문이 `/review` | 수동 재리뷰 |

- **매 push(synchronize) 자동 재리뷰는 하지 않음** → LLM 호출 비용 억제. 필요 시 `/review`로 수동 실행.
- **재실행 시 처리**: 이전 봇 리뷰를 건드리지 않고 **새 리뷰를 누적**으로 추가. (상태 추적/삭제 로직 없음)
- Draft PR: 초기 버전에서는 별도 제외 없음(draft가 opened 되어도 리뷰). 향후 옵션화.

---

## 4. 처리 파이프라인

1. **Webhook 수신** → 서명(HMAC, `X-Hub-Signature-256`) 검증.
2. **즉시 200 응답** (GitHub 10초 타임아웃 회피). 실제 작업은 백그라운드 큐로.
3. **대상 판별**: 위 트리거 조건 매칭. (`issue_comment`는 PR에 달린 것만, 본문 `/review` 정확 매칭)
4. **Installation 토큰 발급** (`@octokit/app`로 해당 설치에 대한 토큰).
5. **diff 수집**: `pulls.listFiles` 페이지네이션 → 파일별 `patch`/`filename`/`status` 확보.
6. **토큰 사전 추정** → 예산 내면 단일 호출, 초과면 분할(§6).
7. **LLM 호출** (tool calling, §5) → 구조화된 findings 수신.
8. **인라인 코멘트 검증** (§7): commentable 라인 집합과 대조, 부적합 항목 드롭/요약 강등.
9. **코멘트 양 제어** (§8): 심각도 순 정렬 후 상한 적용.
10. **Reviews API 게시**: `event: COMMENT` + `body`(요약) + `comments[]`(인라인).
11. **실패 시** (§9): PR에 한 줄 실패 안내 코멘트 + 서버 로그.

> 백그라운드 처리는 in-process 큐(`p-queue`, concurrency 2~3)로 시작. 프로세스 재시작 시 in-flight 작업은 유실될 수 있으나 `/review`로 재시도 가능(허용). 향후 필요 시 Redis 큐로 승격.

---

## 5. LLM 통합 (function/tool calling)

구매한 API가 **function/tool calling 지원** → 구조화 출력을 강제.

### Tool 스키마 (`submit_review`)
```jsonc
{
  "name": "submit_review",
  "parameters": {
    "type": "object",
    "properties": {
      "summary": { "type": "string", "description": "PR 전체에 대한 한국어 요약 평가" },
      "comments": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "path":     { "type": "string" },
            "line":     { "type": "integer", "description": "new-file 기준 라인 번호" },
            "side":     { "type": "string", "enum": ["RIGHT", "LEFT"] },
            "severity": { "type": "string", "enum": ["critical","major","minor"] },
            "body":     { "type": "string", "description": "한국어 지적/제안" }
          },
          "required": ["path","line","side","severity","body"]
        }
      }
    },
    "required": ["summary","comments"]
  }
}
```

### 시스템 프롬프트 핵심
- 역할: 시니어 코드 리뷰어. 출력은 **한국어**.
- 초점: **버그/로직 오류, 보안 취약점, 성능/효율**. 순수 스타일/포매팅/취향 지적은 하지 말 것.
- 확신 없는 추측성 지적 자제, 실질적 결함 위주.
- 각 코멘트는 반드시 diff에 등장한 라인에 앵커.
- `comments`는 **심각도(critical>major>minor) 순으로 정렬**해서 반환(상한 초과 시 하위가 잘리도록).

### 입력 컨텍스트
- PR 제목/본문, 파일별 patch(diff hunk), 파일 경로/상태.

### Fallback / 견고성
- tool calling이 실패하거나 빈 응답 → 관대한 JSON 파싱 재시도 → 그래도 실패면 §9 실패 처리.
- LLM 호출은 재시도 + 지수 백오프(예: 3회). 타임아웃 설정.

---

## 6. diff 처리 & 토큰 예산 & 분할 전략

- 모델 컨텍스트 128K+ → **기본은 전체 diff 단일 호출**.
- **토큰 사전 추정**: `gpt-tokenizer`(또는 tiktoken)로 (시스템 프롬프트 + diff) 토큰 계산.
- **예산** = `모델컨텍스트 − 출력여유(예: 8K) − 안전마진`.
- **초과 시 분할 전략**:
  1. 파일 단위로 배치를 나눠 예산 내로 묶어 여러 번 호출 → 결과 병합(요약은 연결, 코멘트는 합침).
  2. 단일 파일 patch가 예산 초과 → 해당 파일 patch를 잘라 넣고 "일부만 검토됨" 표기.
  3. 파일 수가 과도하게 많으면 상위 N개만 검토하고 요약에 "PR이 너무 커서 일부만 리뷰함" 명시.
- 바이너리/patch 없는 파일은 자연히 건너뜀(`patch` 부재).

> 초기 버전에서는 **노이즈 파일 필터(lock/생성물/vendor)는 넣지 않음**. (향후 확장, §15)

---

## 7. 인라인 코멘트 검증 (Reviews API 제약 대응)

- GitHub Reviews API는 **diff에 포함되지 않은 라인에 코멘트를 달면 리뷰 전체를 422로 거부**함.
- 따라서 파일별 patch hunk를 파싱해 **commentable 라인 집합**(new-file 기준, `side: RIGHT`에 해당하는 추가/문맥 라인)을 구성.
- LLM이 반환한 각 comment의 `(path, line, side)`가 이 집합에 있는지 검증:
  - 유효 → 인라인 코멘트로 포함.
  - 무효 → 드롭하거나 요약 본문에 "(파일:라인) …" 형태로 강등 첨부.
- 게시 전 최종 payload를 검증해 422를 사전 차단.

---

## 8. 코멘트 양 제어

- **상한만 두고 전부**: 심각도 필터링은 하지 않음(critical/major/minor 모두 포함).
- 최대 인라인 코멘트 수 `MAX_INLINE_COMMENTS` (기본 20, 환경변수로 조정).
- LLM이 심각도 순으로 정렬해 반환 → 상한 초과분은 **덜 중요한 것부터 잘림**.
- 잘린 경우 요약에 "그 외 N건의 경미한 지적은 생략" 한 줄 추가.

---

## 9. 실패 처리

- 실패 사유(LLM 오류/파싱 실패/PR 과대/GitHub API 오류) 발생 시:
  - **PR에 간략한 실패 안내 코멘트** 1개 게시 (예: `⚠️ 자동 리뷰 실패: <사유>. /review 로 다시 시도할 수 있습니다.`).
  - 서버 로그에 상세 기록.
- Slack/Discord 등 외부 알림은 향후 확장(§15)으로 남김.

---

## 10. GitHub App 설정

### 권한 (Permissions)
| 항목 | 수준 | 용도 |
|---|---|---|
| Pull requests | Read & Write | diff 조회, Reviews API 게시 |
| Contents | Read | (필요 시) 파일 내용 조회 |
| Issues | Read & Write | `issue_comment`(/review) 수신, 실패 안내 코멘트 게시 |
| Metadata | Read | 필수 |

### 이벤트 구독 (Subscribe to events)
- Pull request
- Issue comment

### 인증
- App ID + Private Key(.pem)로 JWT 발급 → installation access token 교환(`@octokit/app`이 처리).
- Webhook Secret으로 수신 서명 검증.

---

## 11. 배포 (Docker)

- Node.js 앱이 `PORT`로 직접 트래픽을 수신.
- **구성**: `Dockerfile`(node) + `docker-compose.yml`(app).

---

## 12. 환경변수 / 시크릿

| 변수 | 설명 |
|---|---|
| `GITHUB_APP_ID` | App ID |
| `GITHUB_PRIVATE_KEY` | App private key (PEM, 파일 마운트 또는 env) |
| `GITHUB_WEBHOOK_SECRET` | webhook 서명 검증 |
| `LLM_BASE_URL` | OpenAI 호환 엔드포인트 |
| `LLM_API_KEY` | 구매한 API 키 |
| `LLM_MODEL` | 모델명 |
| `LLM_MAX_CONTEXT_TOKENS` | 토큰 예산 계산용 |
| `MAX_INLINE_COMMENTS` | 인라인 상한 (기본 20) |
| `PORT` | 앱 리슨 포트 |

- 시크릿은 `.env`(파일 권한 제한) 또는 컨테이너 시크릿으로 주입. 레포에 커밋 금지.

---

## 13. 프로젝트 구조 (안)

```
review-bot/
├─ src/
│  ├─ index.ts            # 서버 부트스트랩, webhook 등록
│  ├─ webhook.ts          # 이벤트 핸들러(pull_request, issue_comment), 큐 적재
│  ├─ review/
│  │  ├─ pipeline.ts      # 4장 파이프라인 오케스트레이션
│  │  ├─ diff.ts          # listFiles 수집 + patch 파싱 + commentable 라인 집합
│  │  ├─ tokens.ts        # 토큰 추정 + 분할 전략
│  │  ├─ llm.ts           # OpenAI 호환 호출 + tool 스키마 + 재시도
│  │  └─ post.ts          # 검증 + Reviews API 게시 + 실패 코멘트
│  └─ config.ts           # 환경변수 로딩
├─ Dockerfile
├─ docker-compose.yml
└─ package.json
```

주요 의존성: `@octokit/app`, `@octokit/webhooks`, `openai`, `p-queue`, `gpt-tokenizer`(또는 `tiktoken`), 웹서버(`fastify` 또는 `express`).

---

## 14. 구현 마일스톤

1. **M1 — 뼈대**: Express/Fastify + `@octokit/webhooks` 서명 검증 + 즉시 200, 이벤트 로깅.
2. **M2 — GitHub App 연동**: App 생성/설치, installation 토큰, `pulls.listFiles`로 diff 수집.
3. **M3 — diff 파싱**: patch hunk → commentable 라인 집합.
4. **M4 — LLM 연동**: tool calling으로 `submit_review` 수신 + 재시도/파싱 fallback.
5. **M5 — 게시**: 검증 → Reviews API(`COMMENT`) 요약+인라인 게시, 상한/정렬 적용.
6. **M6 — 트리거 완성**: `/review` 코멘트 명령, 실패 안내 코멘트.
7. **M7 — 토큰 예산/분할**: 추정 + 초과 시 분할/축소.
8. **M8 — 배포**: Dockerize + org 설치 테스트.

---

## 15. 향후 확장 (초기 버전 제외 항목 포함)

- **봇/자동화 PR 제외** (dependabot 등) — *초기 제외*.
- **노이즈 파일 자동 제외** (lock/생성물/바이너리/vendor) — *초기 제외*.
- **프롬프트 인젝션 방어** (PR 본문/코드의 숨은 지시문 무력화) — *초기 제외. 외부 org 확장 시 강력 권장*.
- repo별 설정 파일(`.github/review-bot.yml`)로 언어·상한·초점 오버라이드.
- 매 push(synchronize) 재리뷰 + "새 변경분만" 대상 제한.
- 재실행 시 이전 봇 리뷰 dismiss/요약 갱신(중복 회피).
- Draft PR 제외 옵션.
- Slack/Discord 실패·완료 알림.
- in-process 큐 → Redis/BullMQ 승격(재시작 내구성).
- 외부 organization 대상 공개(마켓플레이스/멀티테넌시 운영).

---

## 16. 확인 필요 / 가정

- **LLM 모델명 / rate limit**: 미확정. `LLM_MODEL`·동시성·재시도 파라미터는 운영 중 조정.
- **Draft PR**: 초기엔 리뷰함으로 가정.
- **재실행 누적**으로 인해 PR에 봇 리뷰가 쌓일 수 있음(의도된 선택).
