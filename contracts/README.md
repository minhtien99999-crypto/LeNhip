# Hợp đồng dùng chung

Máy chủ, app iOS và app Android dùng chung các tệp trong thư mục này. Một tệp đổi thì mọi bên phải chạy lại kiểm thử của mình.

| Tệp | Nội dung | Ai dùng |
|---|---|---|
| `openapi.json` | API /v1 (OpenAPI 3.1). Máy chủ kiểm thân yêu cầu trực tiếp bằng các schema trong tệp này. | Client sinh mã, máy chủ, QA |
| `state_transitions.csv` | Bảng chuyển trạng thái đầy đủ: trạng thái nguồn, sự kiện, actor, trạng thái đích, guard, hạn. Máy chủ đọc tệp này khi chạy. | Máy chủ, QA (T07) |
| `fixtures/sleep/S01–S16.json` | Golden fixture LNH-SLEEP-1. Mỗi tệp có đầu vào, kết quả đầy đủ (`expected`) và phép kiểm lấy từ chữ của SRS (`checks`). App phải cho kết quả trùng từng trường. | iOS, Android (T03) |
| `fixtures/jcs-vectors.json` | Vector RFC 8785 và digest SHA-256 base64url, gồm cả payload lịch và đèn. Đầu vào là JSON thô để giữ cách viết số. | iOS, Android, máy chủ (T14) |
| `traceability.json` | Trạng thái của 33 REQ và 22 ca T, tệp mã và tệp kiểm thử tương ứng, mã băm tài liệu nguồn. | Tech Lead, QA |

Quy ước của LNH-SLEEP-1 đã chốt trong bản tham chiếu (chi tiết ở `docs/RA_SOAT_LENHIP_V1_1.md`, LNH-T07 đến LNH-T10):

- Thời gian tính bằng mili giây nguyên.
- Đoạn awake của cùng nguồn được trừ khỏi đoạn ngủ.
- Episode thuộc ngày local chứa thời điểm kết thúc.
- Episode dài quá 24 giờ là lỗi dữ liệu.
- sleep_seconds là giấc chính.
- Giây lấy floor; trung bình làm tròn nửa lên.
- Cần ít nhất 4/7 ngày có quan sát mới tính trung bình, cho cả giấc ngủ lẫn bước chân.
