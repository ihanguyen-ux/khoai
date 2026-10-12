import sys, time, json
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
        ba = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        bb = p.chromium.connect_over_cdp("http://127.0.0.1:9223")
        A = ba.contexts[0].pages[0]
        B = bb.contexts[0].pages[0]
        for pg in (A, B):
            pg.set_viewport_size({"width": 1120, "height": 700})
            s = pg.context.new_cdp_session(pg)
            s.send("Emulation.setFocusEmulationEnabled", {"enabled": True})

        errors = {"A": [], "B": []}
        A.on("console", lambda m: errors["A"].append(m.text) if m.type == "error" else None)
        B.on("console", lambda m: errors["B"].append(m.text) if m.type == "error" else None)
        A.on("pageerror", lambda e: errors["A"].append(str(e)))
        B.on("pageerror", lambda e: errors["B"].append(str(e)))

        # --- Cầu nối preload / bảo mật -------------------------------------
        keysA = A.evaluate("Object.keys(window.winchat || {})")
        check("preload lộ API winchat", "window" in keysA and "server" in keysA, str(keysA))
        check("renderer không có require/process (không lộ Node)",
              A.evaluate("typeof require === 'undefined' && typeof process === 'undefined'"))

        # --- Màn hình đăng nhập --------------------------------------------
        A.screenshot(path=f"{SP}/01-login.png")
        A.get_by_role("button", name="Tạo phòng (Host)").click()
        A.fill("#name", "Hải")
        A.fill("#room", "TEST42")
        A.fill("#port", "3456")
        A.get_by_role("button", name="Tạo phòng & bắt đầu").click()
        A.wait_for_selector("text=Máy này đang làm server", timeout=10000)
        check("Host tạo phòng, server nhúng chạy", True)
        A.screenshot(path=f"{SP}/02-host-waiting.png")

        B.fill("#name", "Lan")
        B.fill("#room", "test42")  # chữ thường -> tự chuẩn hoá
        B.fill("#server", "127.0.0.1:3456")
        B.get_by_role("button", name="Vào phòng").click()
        B.wait_for_selector("text=Hải", timeout=10000)
        A.wait_for_selector("text=Lan đã tham gia phòng", timeout=10000)
        check("Hai máy thấy nhau trong phòng", True)

        # --- Chat -----------------------------------------------------------
        A.fill("textarea", "Xin chào Lan!")
        A.press("textarea", "Enter")
        B.wait_for_selector("text=Xin chào Lan!", timeout=5000)
        check("B nhận tin nhắn từ A", True)
        A.wait_for_selector("text=Đã xem", timeout=5000)
        check("A thấy trạng thái 'Đã xem'", True)

        # typing indicator
        B.type("textarea", "đang soạn", delay=30)
        A.wait_for_selector("text=Lan đang gõ", timeout=4000)
        check("A thấy 'đang gõ...' khi B gõ", True)
        B.press("textarea", "Enter")
        A.wait_for_selector("text=đang soạn", timeout=5000)
        B.screenshot(path=f"{SP}/03-chat-B.png")
        A.screenshot(path=f"{SP}/03-chat-A.png")

        # --- Gọi video ------------------------------------------------------
        A.locator('button[title="Gọi video"]').click()
        B.wait_for_selector("text=đang gọi video cho bạn", timeout=8000)
        check("B nhận hộp thoại cuộc gọi đến", True)
        B.screenshot(path=f"{SP}/04-incoming.png")
        A.screenshot(path=f"{SP}/04-calling-A.png")

        B.locator('button[title="Nghe"]').click()
        # kết nối thành công khi đồng hồ chạy (định dạng 00:0x)
        wait_re(A, r"Cuộc gọi video · 0\d:\d\d", 20.0)
        wait_re(B, r"Cuộc gọi video · 0\d:\d\d", 20.0)
        check("WebRTC P2P kết nối ở cả 2 máy (đồng hồ cuộc gọi chạy)", True)
        time.sleep(2.5)

        def video_state(pg):
            return pg.evaluate("""() => Array.from(document.querySelectorAll('video')).map(v => ({
                w: v.videoWidth, h: v.videoHeight, ready: v.readyState, paused: v.paused,
                tracks: v.srcObject ? v.srcObject.getTracks().map(t => t.kind + ':' + t.readyState) : []
            }))""")

        def audio_state(pg):
            return pg.evaluate("""() => Array.from(document.querySelectorAll('audio')).map(a => ({
                has: !!a.srcObject, tracks: a.srcObject ? a.srcObject.getTracks().map(t => t.kind + ':' + t.readyState + ':' + t.muted) : []
            }))""")

        va, vb = video_state(A), video_state(B)
        print("A videos:", json.dumps(va))
        print("B videos:", json.dumps(vb))
        check("A nhận video từ B (có khung hình thật)", any(v["w"] > 0 and v["h"] > 0 and not v["paused"] for v in va[:1]))
        check("B nhận video từ A (có khung hình thật)", any(v["w"] > 0 and v["h"] > 0 and not v["paused"] for v in vb[:1]))
        aa, ab = audio_state(A), audio_state(B)
        print("A audio:", json.dumps(aa))
        print("B audio:", json.dumps(ab))
        check("A có luồng audio từ B", bool(aa and aa[0]["has"] and any(t.startswith("audio:live") for t in aa[0]["tracks"])))
        check("B có luồng audio từ A", bool(ab and ab[0]["has"] and any(t.startswith("audio:live") for t in ab[0]["tracks"])))
        A.screenshot(path=f"{SP}/05-call-A.png")
        B.screenshot(path=f"{SP}/05-call-B.png")

        # --- Tắt mic / camera -----------------------------------------------
        A.locator('button[title="Tắt mic"]').click()
        B.wait_for_selector("text=Hải đã tắt mic", timeout=5000)
        check("B thấy A tắt mic", True)
        A.locator('button[title="Bật mic"]').click()

        A.locator('button[title="Tắt camera"]').click()
        B.wait_for_selector("text=Hải", timeout=3000)
        time.sleep(0.8)
        vb2 = video_state(B)
        # khi A tắt cam, B không còn render video của A (hiện avatar)
        b_remote_video_visible = B.evaluate("""() => {
            const vs = Array.from(document.querySelectorAll('video'));
            return vs.some(v => v.className.includes('object-contain'));
        }""")
        check("Tắt camera: B chuyển sang avatar thay vì video đen", not b_remote_video_visible)
        B.screenshot(path=f"{SP}/06-cam-off-B.png")
        A.locator('button[title="Bật camera"]').click()
        time.sleep(0.8)
        b_remote_video_visible = B.evaluate("() => Array.from(document.querySelectorAll('video')).some(v => v.className.includes('object-contain'))")
        check("Bật lại camera: B thấy video trở lại", b_remote_video_visible)

        # --- Thu nhỏ cửa sổ nổi ---------------------------------------------
        B.locator('button[aria-label="Thu nhỏ cuộc gọi"]').click()
        time.sleep(0.5)
        B.screenshot(path=f"{SP}/07-minimized-B.png")
        B.fill("textarea", "chat trong lúc đang gọi")
        B.press("textarea", "Enter")
        A.wait_for_selector("text=chat trong lúc đang gọi", timeout=5000)
        check("Vừa gọi vừa chat khi thu nhỏ cuộc gọi", True)

        # --- Kết thúc -------------------------------------------------------
        B.locator('button[aria-label="Kết thúc cuộc gọi"]').click()
        wait_re(A, r"Cuộc gọi video đã kết thúc • \d\d:\d\d", 8.0)
        wait_re(B, r"Cuộc gọi video đã kết thúc • \d\d:\d\d", 8.0)
        check("Kết thúc: cả 2 máy ghi nhật ký cuộc gọi kèm thời lượng", True)
        check("Sau khi kết thúc, không còn lớp cuộc gọi", A.locator('button[title="Kết thúc cuộc gọi"]').count() == 0)

        # camera/mic được giải phóng
        live = A.evaluate("() => navigator.mediaDevices.enumerateDevices().then(d => d.length)")
        print("devices visible:", live)

        # --- Từ chối cuộc gọi thoại -----------------------------------------
        B.locator('button[title="Gọi thoại"]').click()
        A.wait_for_selector("text=đang gọi thoại cho bạn", timeout=8000)
        A.locator('button[title="Từ chối"]').click()
        B.wait_for_selector("text=Đối phương đã từ chối cuộc gọi", timeout=5000)
        check("Từ chối cuộc gọi thoại hoạt động", True)

        # --- Cuộc gọi thoại và kết nối thành công ---------------------------
        A.locator('button[title="Gọi thoại"]').click()
        B.wait_for_selector("text=đang gọi thoại cho bạn", timeout=8000)
        B.locator('button[title="Nghe"]').click()
        wait_re(A, r"Cuộc gọi thoại · 0\d:\d\d", 20.0)
        check("Gọi thoại (audio-only) kết nối thành công", True)
        A.screenshot(path=f"{SP}/08-audio-call-A.png")
        A.locator('button[title="Hủy cuộc gọi"], button[title="Kết thúc cuộc gọi"]').first.click()
        wait_re(B, r"Cuộc gọi thoại đã kết thúc", 8.0)

        # --- Rời phòng ------------------------------------------------------
        A.get_by_role("button", name="Rời phòng").click()
        B.wait_for_selector("text=Hải đã rời phòng", timeout=8000)
        check("Rời phòng: đối phương nhận thông báo", True)
        A.wait_for_selector("#name", timeout=5000)
        check("Rời phòng: quay về màn hình đăng nhập", True)

        print("\nConsole errors A:", errors["A"][:5])
        print("Console errors B:", errors["B"][:5])
        check("Không có lỗi console ở renderer", not errors["A"] and not errors["B"])

    failed = [n for n, ok in results if not ok]
    print(f"\n==== {len(results) - len(failed)}/{len(results)} PASS ====")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)


try:
    main()
except Exception as e:  # in ra ngữ cảnh khi một bước timeout
    print("EXCEPTION:", type(e).__name__, str(e)[:600])
    print("so far:", [(n, ok) for n, ok in results])
    sys.exit(2)
