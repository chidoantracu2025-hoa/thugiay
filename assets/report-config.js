/*
 * Link mặc định dùng chung cho mọi người truy cập baocao.html.
 * Điền link Google Sheet công khai hoặc link CSV xuất bản của từng xã bên dưới.
 * Nếu các xã nằm trong cùng một Sheet, dùng link có gid riêng cho từng tab.
 * Sau khi sửa, đưa file này lên máy chủ cùng baocao.html.
 * Link người dùng tự đổi trên trang chỉ được lưu trong trình duyệt của họ.
 */
window.LAND_REPORT_DEFAULT_CSV = {
  HamGiang: 'https://docs.google.com/spreadsheets/d/1vej1rFYTtpA3962g9lCtFARW3uTjS2v9ff9Rk8lHRuc/edit?gid=564601410#gid=564601410', // Hàm Giang
  TraCu: '',          // Trà Cú
  LongHiep: '',       // Long Hiệp
  TapSon: '',         // Tập Sơn
  LuuNghiepAnh: '',   // Lưu Nghiệp Anh
  DaiAn: ''           // Đại An
};
