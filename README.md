# Jeremina

미나와 남편이 같이 쓰는 앱. 일정·할 일·살 것·루틴·지출(정산)을 공유해요.

- 주소: https://hellong-cpu.github.io/jeremina2026/
- '미나의 하루'(hellong-cpu/mina-day)의 "남편과 공유" 공간(Firestore `spaces/{sid}`)을 같이 읽고 써요.
- 지출은 `spaces/{sid}/expenses` 에 저장되고 Jeremina에서만 보여요. 금액은 엔화로 계산하고, 다른 통화는 그날 환율로 바꿔요.
- 배포할 때마다 index.html의 `APPV`(버전)와 `BUILT`(날짜)를 올려주세요. sw.js의 CACHE 이름도 같이 올려요.
