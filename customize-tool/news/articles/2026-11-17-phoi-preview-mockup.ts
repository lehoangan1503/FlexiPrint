import type { CtNewsArticle } from "../types";

const IMG = "/news/2026-11-17-phoi-preview";

export const phoiPreviewMockup: CtNewsArticle = {
  slug: "phoi-preview-mockup",
  title: "Phôi, ảnh xem trước và mockup: đổi ở đâu, để làm gì",
  createdAt: "2026-11-17",
  thumb: `${IMG}/thumb.jpg`,
  summary: "Product base giữ phôi + ảnh xem trước dùng chung cho mọi sản phẩm; trang Deploy chỉnh khung riêng 1 sản phẩm; trang sản phẩm chỉ tạo mockup. Cách vẽ lại nền bằng AI, nhờ @flexiprint, cập nhật store.",
  blocks: [
    { kind: "h", text: "Tóm tắt" },
    {
      kind: "table",
      head: ["Ở đâu", "Đổi cái gì", "Ảnh hưởng tới"],
      rows: [
        ["**Product base** → Phôi / nền xem trước", "Ảnh xem trước (phôi trơn + lớp phủ + khung dán thiết kế)", "**Mọi sản phẩm** dùng base đó (flexi2 đổi ngay, store sau khi bấm Cập nhật store)"],
        ["**Trang Deploy** của 1 sản phẩm → Vị trí trên ảnh xem trước", "Dời / đổi cỡ khung trên ảnh cho riêng sản phẩm đó", "Chỉ sản phẩm đó"],
        ["**Trang sản phẩm** → Mockup bằng AI", "Ảnh lifestyle cho gallery Shopify", "Chỉ ảnh mockup của sản phẩm đó — không đổi ảnh xem trước"],
      ],
    },
    {
      kind: "note",
      text: "Ảnh xem trước = ảnh khách nhìn trên store khi gõ tên / chọn option: code dán thiết kế **phẳng** vào khung rồi phủ lớp nếp vải, tay, cảnh vật lên trên. AI **không** vẽ thiết kế ở đây, nên thiết kế luôn đúng từng pixel. Mockup thì ngược lại: AI vẽ lại cả bức ảnh (kể cả bản in) cho đẹp.",
    },

    { kind: "h", text: "1. Product base — Phôi / nền xem trước" },
    { kind: "img", src: `${IMG}/base-preview.png`, caption: "Trang product base: ảnh xem trước hiện tại và khung nét đứt (chỗ dán thiết kế)." },
    {
      kind: "list",
      items: [
        "**Phôi trơn**: ảnh sản phẩm trống (nhà in cho, tự tải lên, hoặc AI vẽ).",
        "**Khung nét đứt**: chỗ tờ in (thiết kế) được dán lên ảnh. Ảnh do AI vẽ thì khung tự khớp mặt sản phẩm.",
        "**Lớp phủ** (nếu có, ví dụ ảnh Merchize): phần cảnh / tay / nếp vải nằm **trên** thiết kế. Chỗ lớp phủ đặc là thiết kế bị che.",
        "**Đổi ảnh / Bỏ**: tự tải ảnh phôi của mình.",
      ],
    },
    { kind: "h", text: "“Căn khung tay” là gì?" },
    {
      kind: "p",
      text: "Ba thanh **Cỡ khung · Ngang · Dọc** chỉ dời và đổi cỡ **khung nét đứt** trên ảnh. Ảnh và sản phẩm trong ảnh **không** to / nhỏ theo. Chỉ dùng khi bạn tự tải ảnh lên và khung chưa nằm đúng mặt sản phẩm. Kéo khung to hơn sản phẩm thì thiết kế tràn ra ngoài và bị cắt. Muốn sản phẩm trong ảnh to hơn → vẽ nền AI mới (mục dưới) hoặc đổi ảnh khác.",
    },

    { kind: "h", text: "2. Vẽ lại ảnh xem trước bằng AI" },
    { kind: "img", src: `${IMG}/base-scenes.png`, caption: "Nền bối cảnh (AI): 3 nút mẫu, ô tự mô tả, các nền đã vẽ kèm % thiết kế bị che." },
    {
      kind: "list",
      ordered: true,
      items: [
        "Bấm 1 trong 3 nút (**Nơi dùng quen thuộc · Giáng sinh · Tối giản**) hoặc gõ mô tả rồi bấm **Tạo nền**. Ô mô tả chỉ cần tả **nơi đặt, không khí, đồ trang trí** (ví dụ: “treo trên giường tầng phòng bé trai, có quả bóng đá dưới sàn”).",
        "Đợi 1–3 phút. Ảnh mới hiện thành 1 ô; dòng chữ dưới ô là **% thiết kế bị che** (xanh ≤ 1 %, đỏ từ 5 %). Rê chuột vào để xem từng cạnh.",
        "Bấm ô muốn dùng → bấm **Lưu** (góc trên). Mọi sản phẩm của base trong flexi2 đổi theo ngay.",
        "Bấm **Cập nhật store (N sản phẩm)** ở cuối mục để store đổi theo (chỉ publish lại template — không đụng Shopify, ảnh, giá).",
      ],
    },
    {
      kind: "note",
      text: "Phần kỹ thuật hệ thống tự thêm, gõ gì cũng không phá được: với phôi có lớp phủ và sản phẩm phẳng (chăn), AI nhận 1 khung bố cục hình chữ nhật **magenta** đúng tỉ lệ khuôn in, vẽ sản phẩm **treo thẳng, không người**, mặt in để magenta; code tách ảnh đó lại thành phôi trơn + lớp phủ + khung — giống hệt cách ảnh nhà in được import. Vì vậy thiết kế hiện gần như trọn.",
    },

    { kind: "h", text: "3. Nhờ @flexiprint làm preview" },
    {
      kind: "p",
      text: "Cuối mục Phôi / nền xem trước có ô **Nhờ @flexiprint làm preview**. Ghi yêu cầu (ví dụ: “hợp các mẫu chăn thể thao trẻ em, hiện trọn tên ở dưới”) rồi bấm **Gửi @flexiprint**. Agent sẽ:",
    },
    {
      kind: "list",
      items: [
        "đo phần thiết kế bị che từng cạnh của ảnh hiện tại;",
        "ghép thiết kế **thật** của các sản phẩm trên base lên ảnh để nhìn như khách;",
        "tìm nguyên nhân (sản phẩm nhỏ trong khung, có người che, vải cong, sai tỉ lệ khuôn, cảnh không hợp mẫu…);",
        "tự viết mô tả và vẽ vài nền mới (tối đa 6), kiểm tra từng nền;",
        "đề xuất 1 nền — bấm **Chọn nền agent đề xuất** rồi **Lưu**. Muốn agent đặt luôn thì ghi “đặt luôn” trong yêu cầu.",
      ],
    },
    { kind: "note", tone: "warn", text: "Model ảnh chỉ biết vẽ, không biết phân tích. Phần phân tích là của @flexiprint (đọc số đo, xem ảnh ghép) — nên khi preview chưa ổn, gửi @flexiprint thay vì bấm vẽ lại nhiều lần." },

    { kind: "h", text: "4. Trang sản phẩm — Phôi trơn, Phôi + thiết kế, Mockup bằng AI" },
    { kind: "img", src: `${IMG}/product-mockup.png`, caption: "Trang sản phẩm → Mockup: Phôi trơn và Phôi + thiết kế lấy từ base; ô prompt tạo ảnh mockup." },
    {
      kind: "list",
      items: [
        "**Phôi trơn**: lấy từ product base (chỉ xem). Muốn đổi → bấm link **trang product base**.",
        "**Phôi + thiết kế**: thiết kế đang chọn ở tab Thiết kế dán lên phôi đó — đúng như khách thấy trên store. Đây cũng là ảnh gốc để AI làm mockup.",
        "**Mockup bằng AI**: mỗi dòng prompt = 1 ảnh lifestyle (tối đa 6) cho **gallery Shopify** của riêng sản phẩm này. AI giữ nguyên hình in và chất liệu (hệ thống tự thêm), bạn chỉ tả bối cảnh hợp chủ đề sản phẩm (ví dụ chăn săn bắn → cabin gỗ, lò sưởi).",
      ],
    },
    {
      kind: "table",
      head: ["", "Tạo nền (product base)", "Tạo mockup (sản phẩm)"],
      rows: [
        ["Là gì", "Ảnh xem trước trên store, khách thấy thiết kế của mình ghép lên", "Ảnh lifestyle tĩnh trong gallery Shopify"],
        ["Thiết kế trên ảnh", "Code dán phẳng vào khung — đúng từng pixel", "AI vẽ lại cả ảnh kể cả bản in"],
        ["Yêu cầu", "Hiện đủ artwork, cảnh trung tính hợp cả nhóm mẫu", "Đẹp, đúng chủ đề từng sản phẩm"],
        ["Dùng cho", "Mọi sản phẩm cùng base", "Riêng 1 sản phẩm"],
      ],
    },

    { kind: "h", text: "5. Trang Deploy — Vị trí trên ảnh xem trước" },
    { kind: "img", src: `${IMG}/deploy-box.png`, caption: "Trang Deploy: chỉnh khung riêng cho 1 sản phẩm; đỏ = phần bị ảnh che." },
    {
      kind: "p",
      text: "Cùng kiểu thanh trượt với base nhưng chỉ cho **riêng sản phẩm này** (ví dụ 1 mẫu có tên sát mép dưới, muốn đẩy khung lên một chút). Mặc định dùng khung của base; bấm **Về khung của base** để bỏ chỉnh riêng. Chỉnh xong bấm **Lưu vị trí** rồi Deploy cập nhật. Khung riêng chỉ áp cho đúng ảnh nó được chỉnh — base đổi sang ảnh khác thì sản phẩm tự quay về khung của base.",
    },

    { kind: "h", text: "Câu hỏi hay gặp" },
    {
      kind: "list",
      items: [
        "**Đổi ảnh xem trước ở base thì sản phẩm có đổi không?** Trong flexi2: đổi ngay sau khi Lưu (cả Phôi trơn lẫn Phôi + thiết kế ở trang sản phẩm). Trên store: sau khi bấm **Cập nhật store** ở trang base. Ảnh mockup đã lên Shopify thì không tự đổi.",
        "**Kéo Cỡ khung có làm phôi to lên không?** Không — chỉ khung dán thiết kế đổi. Muốn sản phẩm to hơn trong ảnh: vẽ nền AI mới.",
        "**Preview vẫn che mất chữ?** Xem % che dưới các ô nền, chọn ô xanh; hoặc gửi @flexiprint kèm yêu cầu.",
        "**Muốn ảnh xem trước theo chủ đề từng sản phẩm?** Chưa có — ảnh xem trước dùng chung theo base; chủ đề riêng đưa vào mockup.",
      ],
    },
  ],
};
