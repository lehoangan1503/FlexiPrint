-- =====================================================
-- Customize Tool — the service key may delete clipart folders
--
-- "Tạo bộ custom" (server/char/product.ts remakeSetProduct) runs in a background job with the service key and
-- replaces the set's old product together with its clipart folder; 012 granted INSERT / UPDATE only, so the folder
-- delete failed (403) and the empty folder stayed in the library.
--
-- Additive; run after 001–024.
-- =====================================================

GRANT DELETE ON flexiprint.ct_clipart_categories TO service_role;
