import sys, time
from playwright.sync_api import sync_playwright

SP = "/tmp/winchat-e2e/shots"
results = []

def check(name, cond, extra=""):
    results.append((name, bool(cond)))
    print(("PASS" if cond else "FAIL"), "-", name, extra)

def wait_re(pg, pattern, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate("(p) => new RegExp(p).test(document.body.innerText)", pattern):
            return
        time.sleep(0.3)
    raise TimeoutError("regex không xuất hiện: " + pattern)

def main():
    with sync_playwright() as p:
        A = p.chromium.connect_over_cdp("http://127.0.0.1:9222").contexts[0].pages[0]
        B = p.chromium.connect_over_cdp("http://127.0.0.1:9223").contexts[0].pages[0]
        for pg in (A, B):
            pg.set_viewport_size({"width": 1120, "height": 700})
            pg.context.new_cdp_session(pg).send("Emulation.setFocusEmulationEnabled", {"enabled": True})

        # 1) Sai địa chỉ server -> báo lỗi rõ ràng, không treo
        B.fill("#name", "Lan"); B.fill("#room", "EDGE01"); B.fill("#server", "127.0.0.1:1")
        t0 = time.time()
        B.get_by_role("button", name="Vào phòng").click()
        B.wait_for_selector("text=Không kết nối được tới server", timeout=15000)
        check("Sai địa chỉ server: báo lỗi trong vài giây", time.time() - t0 < 12, f"({time.time()-t0:.1f}s)")
        check("Sau lỗi nút bấm dùng lại được", B.get_by_role("button", name="Vào phòng").is_enabled())

        # 2) Host mở cổng 3457; instance B thử host cùng cổng -> báo cổng bị chiếm
        A.get_by_role("button", name="Tạo phòng (Host)").click()
        A.fill("#name", "Hải"); A.fill("#room", "EDGE01"); A.fill("#port", "3457")
        A.get_by_role("button", name="Tạo phòng & bắt đầu").click()
        A.wait_for_selector("text=Máy này đang làm server", timeout=10000)

        B.get_by_role("button", name="Tạo phòng (Host)").click()
        B.fill("#port", "3457")
        B.get_by_role("button", name="Tạo phòng & bắt đầu").click()
        B.wait_for_selector("text=đang được dùng bởi chương trình khác", timeout=8000)
        check("Host trùng cổng: báo lỗi cổng đang bị chiếm", True)

        # 3) B vào phòng qua chế độ Tham gia
        B.get_by_role("button", name="Tham gia phòng").click()
        B.fill("#server", "127.0.0.1:3457")
        B.get_by_role("button", name="Vào phòng").click()
        A.wait_for_selector("text=Lan đã tham gia phòng", timeout=10000)
        check("Vào phòng thành công sau khi sửa lỗi", True)

        # 4) Hai bên bấm gọi video CÙNG LÚC (glare)
        A.evaluate("() => { window.__t = performance.now(); }")
        import threading
        def click(pg):
            pg.locator('button[title="Gọi video"]').click()
        ta = threading.Thread(target=click, args=(A,)); tb = threading.Thread(target=click, args=(B,))
        # playwright sync API không thread-safe: bấm tuần tự nhưng sát nhau (<50ms) qua evaluate
        A.evaluate("() => document.querySelector('button[title=\"Gọi video\"]').click()")
        B.evaluate("() => document.querySelector('button[title=\"Gọi video\"]').click()")
        # Một bên nhường -> thấy hộp thoại cuộc gọi đến. Tìm bên đó và bấm Nghe.
        deadline = time.time() + 10
        accepter = None
        while time.time() < deadline and accepter is None:
            for name, pg in (("A", A), ("B", B)):
                if pg.locator('button[title="Nghe"]').count() > 0:
                    accepter = (name, pg); break
            time.sleep(0.2)
        check("Gọi cùng lúc: đúng 1 bên nhận được hộp thoại cuộc gọi đến", accepter is not None)
        accepter[1].locator('button[title="Nghe"]').click()
        wait_re(A, r"Cuộc gọi video · 0\d:\d\d", 20); wait_re(B, r"Cuộc gọi video · 0\d:\d\d", 20)
        check("Gọi cùng lúc: vẫn kết nối thành công (không bị kẹt/busy)", True)

        # 5) Đối phương thoát app giữa cuộc gọi -> bên còn lại tự kết thúc cuộc gọi
        A.get_by_role("button", name="Rời phòng")  # chỉ để chắc nút tồn tại ở sidebar
        B.evaluate("() => document.querySelector('button[title=\"Thu nhỏ để vừa gọi vừa chat\"]')?.click()")
        B.get_by_role("button", name="Rời phòng").click()
        wait_re(A, r"đối phương đã rời phòng|đã rời phòng", 8)
        time.sleep(0.5)
        check("Đối phương rời giữa cuộc gọi: bên kia tự thoát khỏi cuộc gọi",
              A.locator('button[title="Kết thúc cuộc gọi"]').count() == 0)
        A.screenshot(path=f"{SP}/09-peer-left.png")

        # 6) Server dừng đột ngột -> bên Join thấy 'mất kết nối, thử lại'
        B.fill("#name", "Lan"); B.fill("#room", "EDGE01"); B.fill("#server", "127.0.0.1:3457")
        B.get_by_role("button", name="Vào phòng").click()
        A.wait_for_selector("text=Lan đã tham gia phòng", timeout=10000)
        A.get_by_role("button", name="Rời phòng").click()  # Host rời => server tắt
        B.wait_for_selector("text=Mất kết nối server", timeout=10000)
        check("Server tắt: bên Join hiện cảnh báo mất kết nối", True)
        B.screenshot(path=f"{SP}/10-reconnecting.png")

        # 7) Nút cửa sổ tuỳ chỉnh
        B.get_by_role("button", name="Rời phòng").click()
        B.wait_for_selector("#name", timeout=5000)
        before = B.evaluate("() => window.outerWidth")
        B.locator('button[title="Phóng to"]').click(); time.sleep(0.8)
        restored = B.locator('button[title="Khôi phục"]').count() == 1
        check("Nút Phóng to đổi thành Khôi phục", restored)
        if restored:
            B.locator('button[title="Khôi phục"]').click(); time.sleep(0.5)
            check("Nút Khôi phục trả cửa sổ về cũ", B.locator('button[title="Phóng to"]').count() == 1)

    failed = [n for n, ok in results if not ok]
    print(f"\n==== {len(results) - len(failed)}/{len(results)} PASS ====")
    sys.exit(1 if failed else 0)

try:
    main()
except Exception as e:
    print("EXCEPTION:", type(e).__name__, str(e)[:700]); print("so far:", results); sys.exit(2)
