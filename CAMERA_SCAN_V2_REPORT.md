# Báo cáo Camera Scan V2 – Adaptive Quality

Ngày kiểm tra: 18/10/2026. Mốc mã trước thay đổi: commit `34676ed` (`2.9`). Các thay đổi V2 nằm trong working tree để có thể xem diff và rollback độc lập.

## 1. Vấn đề và nguyên nhân

Pipeline cũ đã ưu tiên `ImageCapture.takePhoto()`, giữ ảnh gốc, xử lý OpenCV trong Worker và không phóng lớn ảnh nhỏ. Tuy nhiên, chất lượng chỉ được suy ra từ kích thước đầu ra. Ảnh video fallback 1920×1080, ảnh tĩnh bị trình duyệt hạ độ phân giải, hoặc ảnh đủ pixel nhưng mất nét vẫn có thể đi vào danh sách mà không có quyết định rõ ràng của người dùng.

Các nguyên nhân xác định từ mã nguồn:

- Preview 720p giúp giảm nóng, nhưng khi `takePhoto()` lỗi thì fallback có thể lấy khung video độ phân giải thấp. Trước V2 chưa có Quality Gate phát hiện DPI thật sau fallback.
- `effectiveDpi` cũ gắn với chính sách kích thước đầu ra. V2 tính lại từ pixel thật của vùng giấy và kích thước vật lý A3/A4/CCCD. Khi không nhận diện chắc mép giấy, DPI là `unknown`.
- Chưa có phép đo nhiều vùng để phân biệt ảnh nét, ảnh nhòe và trang ít chữ.
- `getPhotoCapabilities()` và `takePhoto()` chưa có timeout riêng; implementation lỗi có thể treo thao tác chụp.
- Giao diện chưa hiển thị nguồn ảnh, pixel thật, DPI, độ nét và quyết định ngoại lệ.

## 2. Audit pipeline trước khi sửa

| File | Function | Current behavior | Risk | Proposed change | Regression impact |
| --- | --- | --- | --- | --- | --- |
| Các trang HTML | `startCamera` | Preview 720p khi có ImageCapture, 1080p khi không có; chọn camera màu; continuous focus nếu hỗ trợ | Trình duyệt có thể bỏ qua constraint | Giữ preview nhẹ, ghi thời gian mở camera, chỉ áp dụng capability được hỗ trợ | Không đổi nghiệp vụ |
| Các trang HTML | `capturePage` | Ưu tiên `takePhoto`, lỗi thì lấy video frame | Video 1080p có thể dưới 200 DPI; promise có thể treo | Timeout hữu hạn, ghi nguồn ảnh, xác nhận độ phân giải thật, Quality Gate sau chụp | Ảnh lỗi vẫn được giữ |
| `scan-runtime.js` | `choosePhotoSettings` | Trần 42 MP/400 dpi hoặc 26 MP/300 dpi | Chế độ nhanh vẫn có thể yêu cầu ảnh lớn | Nhanh dùng trần 26 MP; chất lượng dùng tối đa 42 MP trong giới hạn hiện có | CCCD giữ trần 8 MP |
| `document-scan-worker.js` | `prepareScan` | Dò giấy, chỉnh phối cảnh, cân sáng | Chưa đo nét/DPI nguồn | Đánh giá trên probe 560/720 px trong cùng Worker và cùng lần decode | Không thêm decode ảnh gốc |
| `scan-quality.js` | `outputPolicy` | Không upscale, giới hạn đầu ra 300/400 dpi | Không đủ schema để quyết định ảnh | Thêm DPI nguồn, focus đa vùng, lighting và overall | Giữ API cũ, chỉ mở rộng metadata |
| Các trang HTML | `renderScanItem` | So sánh ảnh gốc/kết quả, xem rõ chữ/chụp lại | Cảnh báo không đủ cụ thể | Hiển thị nguồn, pixel, DPI, nét, lý do và nút giữ ngoại lệ | Không xóa ảnh tự động |
| Các trang HTML | `saveCurrentRecord` | Lưu mọi ảnh trong danh sách | Ảnh fail có thể bị lưu âm thầm | Chặn lưu đến khi chụp lại hoặc xác nhận giữ ảnh | Không đổi payload/API |
| `pdf-export.js` | xuất PDF | JPEG chuẩn, tối đa 10.000.000 byte, chia phần | Nguy cơ dùng ảnh preview nếu nguồn sai | Audit xác nhận dùng `processedBlob`/ảnh gốc thật; không cần đổi | Không đổi PDF |
| `code.gs` | `SAVE_SCAN` | Lưu nhóm PDF và Sheet có retry/idempotency | Không liên quan trực tiếp camera | Audit, không đổi API/backend | Không tác động dữ liệu |

## 3. Kiến trúc sau nâng cấp

`getUserMedia → capability/focus an toàn → takePhoto có timeout → video fallback có constraint và chờ frame mới → Blob/ImageBitmap gốc → Worker dò mép một lần → Quality Gate trên probe → chỉnh phối cảnh/cân sáng → JPEG đã xử lý → xem/xác nhận → PDF ≤ 10 MB → Drive/Sheet`

Ảnh gốc và ảnh đã xử lý vẫn là hai tài nguyên riêng. Thumbnail chỉ dùng hiển thị. `ImageBitmap` và canvas lớn được giải phóng sau khi tạo Blob. Không có dịch vụ ảnh ngoài và không có thuật toán sinh lại chữ.

## 4. Quy tắc chất lượng

Ngưỡng tập trung trong `ScanQuality.QUALITY_THRESHOLDS`:

- GCN A3/A4: dưới 200 dpi `fail`; 200–239 `serious`; 240–299 `review`; từ 300 `pass` về độ phân giải.
- CCCD dùng ngưỡng riêng 250/300/350 dpi do kích thước vật lý và chữ nhỏ trên thẻ.
- DPI nguồn lấy cạnh giới hạn của vùng giấy thật theo mm. Không nhận diện được vùng giấy thì DPI `unknown`. Kích thước đầu ra không được dùng để nâng trạng thái DPI.
- Độ nét kết hợp variance Laplacian, gradient/edge density và local contrast trên 5 vùng ở chế độ nhanh, 9 vùng ở chế độ chất lượng. Ngưỡng dùng cả giá trị tuyệt đối và tương quan giữa các vùng. Trang trắng/ít chữ trả `uncertain`; không bị kết luận mờ chỉ vì thiếu cạnh.
- Ánh sáng kiểm tra thiếu sáng, không đều và vùng sáng mạnh. `possibleGlare` chỉ là cảnh báo; không tuyên bố đo chuyển động thật từ một khung hình.
- `fail` hoặc `review` được giữ nguyên cùng ảnh gốc. Người dùng chọn chụp lại, xem rõ chữ hoặc xác nhận “Giữ ảnh”. Hồ sơ chưa được lưu nếu còn ảnh chưa quyết định.

## 5. File và function thay đổi

- `assets/scan-quality.js`: `QUALITY_THRESHOLDS`, `dpiStatus`, `sourceResolution`, `focusAssessmentFromPixels`, `assessQuality`.
- `assets/document-scan-worker.js`: chạy Quality Gate trong cùng tác vụ scan và trả metadata/timing.
- `assets/scan-runtime.js`: `choosePhotoSettings` thích ứng chế độ nhanh/chất lượng.
- Sáu trang HTML: chế độ vận hành, timeout camera, fallback kiểm tra độ phân giải thực, metadata nguồn/timing, giao diện chất lượng, xác nhận ngoại lệ và chặn lưu an toàn.
- Tests: cập nhật hợp đồng Blob/Canvas và thêm trường hợp DPI, nét, ít chữ, timeout/session/fallback qua các suite hiện có.

`assets/pdf-export.js`, QR worker, OpenCV.js, jscanify và `code.gs` được audit nhưng không sửa cho V2 vì không có lỗi trực tiếp cần thay đổi. Vendor/minified được giữ nguyên.

## 6. Kết quả kiểm thử

- Toàn bộ 10 suite Node hiện có đạt: camera lifecycle, land scan, PDF export/save, report, scan quality/runtime/session và server concurrency.
- Browser harness Chromium: 18 PASS, 0 FAIL, 1 SKIP (`test.jpg` không có trong repository). Bao gồm A4 phẳng/nhăn/nghiêng/xoay, A3 spread, Worker song song, màu, PDF và giới hạn 10 MB.
- Integration thật trong Chromium với ảnh A3 tổng hợp 5600×4000: nhận vùng giấy 5104×3564, DPI nguồn 304,8, focus `pass`, giữ đúng File gốc, giải phóng canvas lớn, tạo PDF 1.574.928 byte.
- Ảnh tổng hợp mờ/độ phân giải thấp: vùng giấy 1922×1314, 112,4 dpi, overall `fail`, giữ ảnh gốc và cho phép xác nhận ngoại lệ.
- Ảnh tổng hợp đủ 314,5 dpi nhưng làm mờ 7 px: độ phân giải `pass`, focus `uncertain`, overall `review`; hệ thống không tự coi ảnh đủ pixel là ảnh rõ nét.
- QR CCCD, OCR adapters, xem rõ chữ, thay/chụp lại/xóa, thứ tự trang, retry Drive/Sheet và đồng thời nhiều request đều qua regression test.

## 7. Benchmark có thật trên môi trường phát triển

Ảnh A3 tổng hợp 5600×4000 chạy trong Chromium headless trên máy phát triển:

- Quality Gate: 19,2 ms.
- Dò giấy + chỉnh hình + cân sáng: 2.124,2 ms.
- Từ bắt đầu nhập ảnh đến sẵn sàng: 2.882,9 ms.
- JPEG đã xử lý: 1.571.580 byte; PDF một trang: 1.574.928 byte.

Chi phí Quality Gate đo được dưới mục tiêu 200–300 ms trên máy này. Đây không phải benchmark điện thoại. Không có số RAM đáng tin cậy từ thiết bị vật lý trong môi trường hiện tại, nên chưa tuyên bố đạt trên Android cấu hình thấp, Android trung bình/cao hoặc iPhone.

## 8. Bảng nghiệm thu

| Tiêu chí | Trước nâng cấp | Sau nâng cấp | Trạng thái |
| --- | --- | --- | --- |
| Chọn ảnh tĩnh | Có ImageCapture, chưa timeout riêng | Ưu tiên ảnh tĩnh, capability thực, timeout hữu hạn | Đạt bằng test/mã |
| Video fallback | Yêu cầu cao hơn nhưng chưa phân loại nguồn | Xác nhận pixel thật, chờ frame mới, gắn nguồn và Quality Gate | Đạt bằng test/mã |
| DPI thực | Gắn với policy đầu ra | Tính từ pixel vùng giấy; không rõ khổ trả unknown | Đạt |
| Độ nét | Chưa đánh giá độc lập | Đa vùng, nhiều chỉ số, có uncertain cho trang ít chữ | Đạt bằng synthetic test |
| Tốc độ xử lý | Worker và preview nhẹ | Quality Gate cùng decode/Worker, 19,2 ms trên máy phát triển | Đạt trong môi trường thử |
| Bộ nhớ | Blob/ImageBitmap, giải phóng canvas | Giữ nguyên; probe tối đa 560/720 px | Đạt bằng lifecycle test |
| PDF | 300/400 dpi, ≤10 MB, chia phần | Giữ nguyên, không upscale và không dùng thumbnail | Đạt |
| Camera Android | ImageCapture/fallback | Adaptive capability + camera hệ thống | Chưa kiểm thử máy thật |
| Camera iOS | Chủ yếu file capture/fallback | Camera hệ thống được giữ và gắn nguồn | Chưa kiểm thử máy thật |

## 9. Giới hạn và rủi ro còn lại

- Web API không thể buộc mọi camera điện thoại lấy nét hoặc dùng cảm biến chính. Trên máy không hỗ trợ ImageCapture, camera hệ thống vẫn là lựa chọn tốt nhất.
- Phép đo nét từ một ảnh không chứng minh chuyển động thật. Kết quả `uncertain` chủ động yêu cầu kiểm tra thay vì đoán.
- Dò sai mép giấy làm DPI không đáng tin; trường hợp đó được trả `unknown` và yêu cầu quyết định.
- Cần pilot trên ít nhất một Android cấu hình thấp, một Android tầm trung/cao và một iPhone trước khi triển khai diện rộng; đo camera start, capture, nhiệt độ cảm nhận, crash/RAM và khả năng đọc chữ nhỏ thật.

## 10. Rollback và triển khai

Mốc rollback là commit `34676ed`. Trước khi triển khai nên commit riêng toàn bộ thay đổi V2. Khi cần quay lại, dùng `git revert <commit-camera-scan-v2>` để tạo lịch sử rollback an toàn; không dùng reset/force push. Có thể khôi phục riêng sáu HTML và ba module scan từ commit mốc nếu chưa commit V2.

Triển khai đề xuất: pilot `HamGiang.html` với 20–30 hồ sơ thật trên ba nhóm điện thoại, đối chiếu chữ nhỏ/số tờ/số thửa và log timing không nhạy cảm; sau khi đạt mới phát hành cùng phiên bản đã kiểm thử cho Tra Cú, Long Hiệp, Tập Sơn, Lưu Nghiệp Anh và Đại An. Mã sáu trang đã được đồng bộ trong repository để regression test, nhưng vẫn nên phát hành theo thứ tự pilot này.

## 11. Lưu hồ sơ không có PDF và đánh giá tốc độ Drive

Đã sửa nhánh không có ảnh: nút **Lưu hồ sơ** luôn gọi `SAVE_SCAN`. Hồ sơ mới hoặc hồ sơ đang sửa đều gửi đủ tên huyện/xã, chủ sử dụng, tờ/thửa mới và cũ, diện tích, mục đích, ấp, thế chấp, số CCCD và ghi chú dù `pageCount = 0`. Nút **Chỉ lưu ghi chú** vẫn giữ đúng chức năng riêng khi người dùng chủ động bấm nó. Trường hợp chỉ có ảnh CCCD gửi hai nhóm `original` và `cccd`, không tạo hoặc gửi nhóm GCN rỗng.

Test sáu trang xác nhận:

- Không có ảnh: một request `SAVE_SCAN`, đủ metadata, không export PDF, không tạo trường PDF rỗng.
- Chỉ có CCCD: lưu bản gốc và PDF CCCD, giữ đủ metadata, không export PDF GCN.
- Backend lưu chính xác `pageCount = 0` thay vì mặc định thành 1 và không tạo file Drive.

Đánh giá tốc độ hiện tại cho thấy phần mã đã có các tối ưu quan trọng: PDF không đổi được tái sử dụng, chỉ nhóm ảnh thay đổi được upload lại, canvas/JPEG có cache giới hạn, upload Drive không giữ khóa Sheet, thư mục Drive được cache, multipart chỉ chia sẻ thư mục một lần và retry tiếp tục từ phần đã lưu.

Các phương án cải thiện tiếp theo, theo mức hiệu quả và rủi ro:

1. Đo riêng `pdfBytesSent` và `uploadMs` trên điện thoại/mạng thật để xác định nghẽn do mạng hay Drive. Không cần ghi nội dung hồ sơ.
2. Thêm lựa chọn nghiệp vụ cho bản gốc: giữ nguyên ba nhóm như hiện tại hoặc chỉ tạo bản gốc khi hồ sơ yêu cầu. Đây là thay đổi có tác động lớn nhất vì hiện một ảnh có thể xuất hiện trong cả bản gốc và PDF đã xử lý, nhưng chỉ nên làm sau khi đơn vị xác nhận quy định lưu trữ.
3. Chia request thành `UPLOAD_GROUP` và `COMMIT_RECORD`, cho phép tải các nhóm độc lập rồi ghi Sheet một lần. Thiết kế này hỗ trợ retry tốt hơn trên mạng yếu; không nên chạy song song quá nhiều vì quota Apps Script/Drive và RAM điện thoại.
4. Với hệ thống có đăng nhập Google, dùng Drive API resumable upload để gửi Blob nhị phân và tiếp tục phần bị đứt. Cách này loại bỏ khoảng 33% overhead Base64 nhưng cần OAuth, CORS, quyền Drive và thay đổi triển khai lớn.
5. Nếu quyền truy cập cho phép, chia sẻ thư mục gốc một lần và để file đơn kế thừa quyền, giảm một lệnh `setSharing` cho mỗi PDF. Cần pilot vì chính sách Drive Workspace có thể chặn hoặc xử lý kế thừa khác nhau.

Không có phép đo Google Drive production trong phiên làm việc này; các kết luận tốc độ Drive ở trên dựa trên audit luồng và kích thước truyền, không được trình bày như benchmark mạng thật.

## 12. Nhật ký tốc độ lưu thực tế trên GitHub

Sáu trang quét không lưu nhật ký vào điện thoại và không hiển thị nút tải/xóa log. Sau khi `SAVE_SCAN` hoàn tất, Apps Script cấp một mã ghi log dùng một lần, có hiệu lực tối đa 10 phút. Trình duyệt gửi một request nền `LOG_PERFORMANCE` với `keepalive`; request này không được `await`, nên thời gian GitHub không nằm trên đường chờ lưu hồ sơ và lỗi log không thay đổi thông báo nghiệp vụ.

Apps Script lọc lại dữ liệu rồi tạo một file JSON riêng cho mỗi lần lưu tại:

`performance-logs/YYYY-MM-DD/<UTC>_<trang>_<event-id>.json`

Dùng file bất biến theo từng sự kiện tránh xung đột SHA khi nhiều người lưu cùng lúc. Đổi `GITHUB_LOG_PATH_PREFIX` nếu muốn thư mục khác. Mỗi sự kiện tạo một commit GitHub; nên đặt `GITHUB_LOG_BRANCH` thành nhánh log riêng nếu repository có workflow/deploy chạy trên nhánh chính.

Các số đo gồm `exportMs`, `requestMs`, `totalMs`, `pdfBytesSent`, số trang, trạng thái, thời gian Drive/Sheet từ Apps Script và thông tin thiết bị/mạng do trình duyệt cung cấp. Danh sách trường cho phép được áp dụng ở cả trình duyệt và Apps Script. Log không chứa ảnh, họ tên, số CCCD, ghi chú/OCR, tên file, URL API, URL Drive, chỉ số dòng Sheet hoặc token GitHub.

Cấu hình trong **Apps Script → Project Settings → Script Properties**:

- `GITHUB_LOG_TOKEN`: fine-grained personal access token, chỉ cấp quyền **Contents: Read and write** cho repository log.
- `GITHUB_LOG_REPOSITORY`: mặc định `chidoantracu2025-hoa/thugiay`.
- `GITHUB_LOG_BRANCH`: mặc định `main`; nên dùng nhánh log riêng đã tạo sẵn.
- `GITHUB_LOG_PATH_PREFIX`: mặc định `performance-logs`.

Sau khi đặt properties, chạy thủ công `authorizeGitHubPerformanceLogging` một lần trong Apps Script Editor, chấp nhận quyền gọi dịch vụ ngoài rồi triển khai Web App phiên bản mới. Hàm chỉ đọc thông tin repository để kiểm tra token và cấp scope; không tạo log hoặc sửa repository.

Không đặt token trong HTML hoặc commit token vào repository. Nếu thiếu cấu hình, token hết hạn, mất mạng hoặc GitHub lỗi, hồ sơ vẫn được lưu bình thường và chỉ sự kiện log đó bị mất. Các lỗi xảy ra trước khi server hoàn tất `SAVE_SCAN` không có mã dùng một lần nên không được gửi lên GitHub.

Để đánh giá thực tế, nên thu ít nhất 5 lần cho mỗi nhóm: chỉ metadata, chỉ CCCD, GCN 1–3 trang và hồ sơ phải chia PDF; sau đó tính trung vị và p95. Nếu `exportMs` cao, điểm nghẽn ở tạo/nén PDF. Nếu `requestMs` cao nhưng `serverTiming.totalMs` thấp, điểm nghẽn chủ yếu ở mạng/Base64. Nếu `driveMs` cao, điểm nghẽn ở Drive; nếu `sheetMs` cao, cần kiểm tra khóa hoặc thao tác Sheet.

Kiểm thử Web App thật ngày 2026-10-18 lần đầu: `SAVE_SCAN` không PDF thành công tại dòng Sheet 12289 trong 3,740 giây phía máy gọi; server báo tổng 1,239 giây, gồm validation 0,653 giây, Drive 0 giây và Sheet 0,586 giây. `LOG_PERFORMANCE` bị Google từ chối vì deployment chưa cấp scope `script.external_request`; lần này không tạo file GitHub.

Sau khi cấp quyền và triển khai lại, lần kiểm thử thứ hai thành công tại dòng Sheet 12290: tổng phía máy gọi 3,870 giây; server 1,337 giây, gồm validation 0,708 giây, Drive 0 giây và Sheet 0,629 giây. Apps Script ghi thành công file `performance-logs/2026-10-18/20261018T070909737Z_HamGiang_field_retest_20261018_002.json` trên nhánh `main`. Nội dung tải lại từ GitHub khớp toàn bộ timing; các giá trị thử ở trường họ tên, CCCD, OCR, API URL và token không xuất hiện. Gửi lại cùng mã log bị từ chối đúng thiết kế, xác nhận mã chỉ dùng một lần.

Kiểm thử có PDF thật thành công tại dòng Sheet 12291 với một PDF A4 giả lập 300 DPI, một trang, 793.977 byte được gửi cho cả nhóm bản gốc và GCN. Hai file Drive được tạo và mở công khai thành công; kết quả trả `originalBackupSaved: true`, mỗi nhóm một phần và không có nhóm thiếu. Tổng 1.587.954 byte PDF được gửi trong request 2.117.930 byte; thời gian phía máy gọi 13,896 giây. Server xử lý 9,002 giây, gồm validation 0,751 giây, Drive 7,609 giây và Sheet 0,642 giây. Log GitHub được tạo thành công tại `performance-logs/2026-10-18/20261018T071342251Z_HamGiang_field_pdf_test_20261018_003.json`; tải lại xác nhận đúng dung lượng/timing và không có dữ liệu riêng tư thử nghiệm.

## 13. Adaptive PDF 300/400 DPI và mục tiêu dung lượng

Từ log thực tế 2 trang ngày 2026-10-18 (15,32 MiB PDF, tổng 65,88 giây, mạng 3G), luồng lưu đã được cập nhật để giảm dữ liệu trước khi upload:

- Chế độ nhanh tự xuất 300 DPI khi Network Information API báo `slow-2g`, `2g`, `3g` hoặc downlink không quá 2 Mbps. Mạng tốt giữ 400 DPI; chế độ ưu tiên chất lượng giữ lựa chọn 400 DPI. Nếu trình duyệt không cung cấp thông tin mạng, cấu hình người dùng được giữ nguyên.
- Ngân sách tính theo toàn bộ nhóm PDF: GCN 3.000.000 byte, CCCD hai mặt 700.000 byte, bản gốc mục tiêu 2.500.000 byte và giới hạn chia mềm 3.500.000 byte. GCN dùng giới hạn chia mềm 3.500.000 byte; CCCD 900.000 byte.
- JPEG bắt đầu ở 0,96 và chỉ giảm khi chưa đạt mục tiêu. Sàn chất lượng là 0,85 cho GCN, 0,88 cho CCCD và 0,82 cho bản gốc. Nếu một trang vẫn vượt giới hạn mềm ở mức sàn, trang được giữ nguyên thay vì hạ DPI; các trang khác được tách thành phần có thứ tự.
- Giới hạn cứng 10 MB mỗi file và cơ chế chia PDF vẫn giữ nguyên.
- Ảnh nguồn, kích thước pixel dùng cho Quality Gate và bản chụp trước xử lý không bị thay thế. Cache PDF phân biệt DPI/mục tiêu byte để không tái sử dụng nhầm bản 400 DPI khi mạng chuyển sang 300 DPI.
- DPI thực tế dùng khi xuất được ghi vào log GitHub qua trường `outputDpi`.
- Tổng thao tác lưu có ngân sách chờ 40 giây trên trình duyệt. Nếu hết thời gian, UI thông báo rõ, giữ ảnh và đổi nút thành **Cập nhật / lưu tiếp**. Request đang chạy được đánh dấu chưa chắc chắn; lần bấm sau gọi `SAVE_STATUS` trước khi gửi lại để tránh tạo file/dòng trùng.

Chưa có log điện thoại thực tế sau thay đổi này, vì vậy mức giảm từ 65,88 giây vẫn là mục tiêu cần đo lại, chưa phải kết quả benchmark đã xác nhận.
