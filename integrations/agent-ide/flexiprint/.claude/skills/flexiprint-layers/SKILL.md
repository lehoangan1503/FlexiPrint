---
name: flexiprint-layers
description: Luật BẮT BUỘC khi làm / kiểm tra / tạo bằng AI thiết kế ráp từ nhiều layer đổi được (nhân vật: da, áo, quần, giày, tóc trước-sau, phụ kiện) — mọi file cùng 1 master, cùng khung, cùng ô, không lệch 1 px.
---

# Thiết kế nhiều layer — luật canh pixel (bắt buộc)

Đọc `flexiprint://guide/layer-rules` (bản đầy đủ, tiếng Anh) trước khi làm bất cứ việc gì với bộ layer.

Tóm tắt — vi phạm 1 điều là lệch, không chỉnh trong editor được:
1. **Một file master, một khung** (vd. 1000×1000), một dáng gốc. Mọi phần, mọi màu, mọi kiểu đều vẽ trong master đó.
2. **Xuất nguyên khung, không cắt sát viền**, không đổi cỡ, không canh giữa lại. Vị trí nằm trong phần trong suốt.
3. **Mỗi slot một ô cố định** trên sản phẩm; mọi lựa chọn của slot vẽ đúng ô đó, không transform riêng từng clipart.
4. **Thứ tự lớp cố định**: tóc sau → da → quần → áo → đầu → mắt → giày → tóc trước → phụ kiện → chữ.
5. **Phần vừa sau vừa trước (tóc, khăn, áo choàng) = 2 layer**: lớp SAU = cả phần; lớp TRƯỚC = chính pixel đó,
   xoá mặt / cổ / phần nằm sau thân. Xoá, không vẽ lại. Kiểu không có phần sau → file trống cùng khung.
6. **Slot liên kết**: lớp sau không cho khách chọn, nó theo lựa chọn lớp trước — hai cây thư mục song song, cùng tên
   nhóm, cùng số thứ tự (1_1…1_N).
7. **Dáng gốc không đổi**: mặt luôn ở cùng pixel. Dáng khác = bộ master khác.
8. **Không bao giờ chấm điểm cắt hay đặt bằng mắt** cho phần của nhân vật — chấm điểm chỉ dùng cho khuôn sản phẩm.
9. **AI tạo phần mới** = sửa tại chỗ trên master (cùng cỡ, cùng dáng) rồi tách trên đúng khung đó; không tạo rời rồi co vào.
10. **Kiểm tra trước khi dùng**: cùng cỡ file trong slot; cùng ô; bbox alpha đúng chỗ; lớp trước ⊆ lớp sau (≥ 95%);
    slot liên kết cùng tên nhóm, cùng số lượng, cùng thứ tự.

Thấy file vi phạm → báo người dùng bằng tiếng Việt: file nào, luật số mấy, cách sửa. Không tự "canh lại cho khớp".
