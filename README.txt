Render 배포 빠른 가이드(Zip 업로드용)
1) Render → New → Web Service → Manual Deploy(Upload ZIP) 선택
2) 이 ZIP 업로드
3) Environment 탭에서 다음 값이 .env로 들어가도록 Add Env Vars (선택) 또는 파일 그대로 사용
4) Start Command: node server.js  (Build Command는 비워도 됩니다. Render가 npm i 자동 실행)
5) 배포 후 확인:
   - /healthz → ok
   - /rumited2025JTBC → 주자 등록 폼
   - /viewer/rumited2025JTBC?t=rumited-crew-only → 실시간 뷰
주의: 실제 대회 페이지의 테이블 구조가 다르면 server.js의 테이블 선택자를 조정해야 합니다.