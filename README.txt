v2.2b 변경점 (문제 회피용 최소구성)
- 외부 모듈(Express/Cheerio 등) 완전 제거 → 설치 실패 이슈 원천 차단
- 내장 http/SSE만으로 등록/뷰어/리프레시/하이라이트 구현
- 스크랩은 내장 fetch + 단순 table 파서(필요시 선택자 커스터마이즈 대신 정규식 파서)

Render 설정
- Start Command: node server.js
- Build Command: (비워도 OK)