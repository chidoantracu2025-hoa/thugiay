/*
 * Link mặc định dùng chung cho mọi người truy cập baocao.html.
 * Điền link Google Sheet công khai hoặc link CSV xuất bản của từng xã bên dưới.
 * Nếu các xã nằm trong cùng một Sheet, dùng link có gid riêng cho từng tab.
 * Sau khi sửa, đưa file này lên máy chủ cùng baocao.html.
 * Link người dùng tự đổi trên trang chỉ được lưu trong trình duyệt của họ.
 */
window.LAND_REPORT_DEFAULT_CSV = {
  HamGiang: 'https://docs.google.com/spreadsheets/d/1vej1rFYTtpA3962g9lCtFARW3uTjS2v9ff9Rk8lHRuc/edit?gid=564601410#gid=564601410', // Hàm Giang
  TraCu: 'https://docs.google.com/spreadsheets/d/1SLXJImpc2lstqLkEQz5qmmEpNH3r02lT0PuQh3UWdQ4/edit?gid=645964555#gid=645964555',          // Trà Cú
  LongHiep: 'https://docs.google.com/spreadsheets/d/1erA4yZMFBy_le-sKgALq0PgxPgJ9apT2ofcVlcX4SjI/edit?gid=1513781825#gid=1513781825',       // Long Hiệp
  TapSon: 'https://docs.google.com/spreadsheets/d/1ek5UBKB0sztihF7S7Rro25IpgdifnJO7jwLh4MQDxWA/edit?gid=500329011#gid=500329011',         // Tập Sơn
  LuuNghiepAnh: 'https://docs.google.com/spreadsheets/d/1usSWPfNGioDXB_JNq3lUqWTpGxWRzXi8wBVC4Bj-E0k/edit?gid=7390388#gid=7390388',   // Lưu Nghiệp Anh
  DaiAn: 'https://docs.google.com/spreadsheets/d/1xLBSTqBF7TA41G0W0qBXov6NcYaMfaJgOsvV6BnFpqY/edit?gid=1780440792#gid=1780440792'           // Đại An
};
