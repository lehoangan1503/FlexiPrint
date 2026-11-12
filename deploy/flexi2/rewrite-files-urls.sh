#!/bin/bash
# Đổi url file cũ trong DB flexi2: https://flexi2.next.lc/files/<key> → https://cdn.teein.top/flexi2/<key>.
# KHÔNG BẮT BUỘC: url cũ vẫn chạy (app /files/). Lợi ích: ảnh cũ cũng tải thẳng từ Cloudflare (~0,05 s thay vì ~1,7 s từ Mỹ).
# Mặc định chỉ ĐẾM (chỉ đọc). Ghi thật: --apply (cần chủ hệ duyệt; pg_dump trước; sau đó Publish lại sản phẩm để template
# trên cửa hàng nhận url mới). Mọi cột text / varchar / jsonb của schema flexiprint có chứa tiền tố cũ.
# Chạy trên an-vm:  sudo bash deploy/flexi2/rewrite-files-urls.sh [--apply]
set -euo pipefail
OLD="https://flexi2.next.lc/files/"
NEW="https://cdn.teein.top/flexi2/"
SCHEMA="flexiprint"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
psql() { docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }

cols=$(psql -c "select table_name||'|'||column_name||'|'||data_type from information_schema.columns
  where table_schema='$SCHEMA' and data_type in ('text','character varying','jsonb')
  and table_name in (select table_name from information_schema.tables where table_schema='$SCHEMA' and table_type='BASE TABLE')")
total=0
for c in $cols; do
  IFS='|' read -r t col typ <<<"$c"
  expr="\"$col\"::text"
  n=$(psql -c "select count(*) from $SCHEMA.\"$t\" where $expr like '%$OLD%'")
  [ "$n" = "0" ] && continue
  echo "$t.$col ($typ): $n dòng"
  total=$((total + n))
  if [ $APPLY = 1 ]; then
    if [ "$typ" = "jsonb" ]; then set_expr="replace(\"$col\"::text, '$OLD', '$NEW')::jsonb"; else set_expr="replace(\"$col\", '$OLD', '$NEW')"; fi
    psql -c "update $SCHEMA.\"$t\" set \"$col\" = $set_expr where $expr like '%$OLD%'" >/dev/null
  fi
done
echo "tổng: $total dòng-cột $([ $APPLY = 1 ] && echo 'ĐÃ ĐỔI' || echo '(chỉ đếm, chưa đổi gì)')"
