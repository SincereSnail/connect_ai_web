# Connect AI Web

원본 VS Code 확장프로그램 UI를 웹에서 실행하는 로컬 어댑터입니다.

## 실행

```bash
npm run web
```

브라우저에서 다음 주소를 엽니다.

```text
http://127.0.0.1:4825
```

## 설정

첫 실행 시 `web-data/config.json`이 생성됩니다.

- `ollamaUrl`: Ollama 주소, 기본값 `http://127.0.0.1:11434`
- `lmStudioUrl`: LM Studio 주소, 기본값 `http://127.0.0.1:1234`
- `defaultModel`: 기본 모델명
- `workspaceRoot`: 파일 생성, 수정, 명령 실행을 허용할 작업 폴더
- `localBrainPath`: 웹 버전 지식 폴더

## 구현 방식

`web-server.js`가 `out/extension.js` 안의 원본 webview HTML을 런타임에 그대로 추출하고,
브라우저의 `acquireVsCodeApi().postMessage(...)` 호출을 로컬 HTTP/SSE 브리지로 연결합니다.
Ollama/LM Studio 스트리밍, 새 대화, 모델 감지, 상태 표시, 파일 생성/수정, 명령 실행 액션 태그가 웹에서 동작합니다.
