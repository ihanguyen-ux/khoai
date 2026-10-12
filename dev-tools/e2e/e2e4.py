import sys, time, subprocess, os
from playwright.sync_api import sync_playwright

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

ENV = {"DISPLAY": ":99", "PATH": "/usr/bin:/bin"}
def wm_states():
    wins = subprocess.run("xwininfo -root -tree | grep -i winchat | awk '{print $1}'", shell=True, capture_output=True, text=True, env=ENV).stdout.split()
    return wins, [subprocess.run(["xprop", "-id", w, "_NET_WM_STATE"], capture_output=True, text=True, env=ENV).stdout for w in wins]

SERVER = "127.0.0.1:8787"
KEY = "khoa-test"

def join(pg, name, key):
    pg.fill("#name", name)
    pg.fill("#room", "CFROOM9")
    pg.fill("#server", SERVER)
    pg.get_by_text("Nâng cao: khoá truy cập, TURN riêng").click()
    pg.fill("#accessKey", key)
    pg.get_by_role("button", name="Vào phòng").click()

def main():
    with sync_playwright() as p:
        A = p.chromium.connect_over_cdp("http://127.0.0.1:9222").contexts[0].pages[0]
        B = p.chromium.connect_over_cdp("http://127.0.0.1:9223").contexts[0].pages[0]
        for pg in (A, B):
            pg.set_viewport_size({"width": 1120, "height": 700})
            s = pg.context.new_cdp_session(pg)
            s.send("Emulation.setFocusEmulationEnabled", {"enabled": True})

        # --- khoá sai ---
        join(A, "Hải", "sai-khoa")
        A.wait_for_selector("text=Khoá truy cập không đúng", timeout=10000)
        check("Sai khoá truy cập: báo lỗi rõ ràng", True)
        A.fill("#accessKey", KEY)
        A.get_by_role("button", name="Vào phòng").click()
        A.wait_for_selector("text=Bạn: Hải", timeout=10000)
        check("Đúng khoá: vào phòng qua Cloudflare Worker (local)", True)

        join(B, "Lan", KEY)
        B.wait_for_selector("text=Bạn: Lan", timeout=10000)
        A.wait_for_selector("text=Lan đã tham gia phòng", timeout=10000)
        check("Hai máy thấy nhau qua Worker", True)

        # chặn ghi nhận cấu hình RTCPeerConnection để kiểm tra iceServers
        for pg in (A, B):
            pg.evaluate("""() => {
              const O = window.RTCPeerConnection; window.__cfg = [];
              window.RTCPeerConnection = function (c, ...r) { window.__cfg.push(JSON.parse(JSON.stringify(c || {}))); return new O(c, ...r); };
              window.RTCPeerConnection.prototype = O.prototype;
            }""")

        A.fill("textarea", "chào qua Cloudflare")
        A.press("textarea", "Enter")
        B.wait_for_selector("text=chào qua Cloudflare", timeout=5000)
        A.wait_for_selector("text=Đã xem", timeout=5000)
        check("Chat + 'Đã xem' qua Worker", True)

        A.locator('button[title="Gọi video"]').click()
        B.wait_for_selector("text=đang gọi video cho bạn", timeout=8000)
        B.locator('button[title="Nghe"]').click()
        wait_re(A, r"Cuộc gọi video · 0\d:\d\d", 25)
        wait_re(B, r"Cuộc gọi video · 0\d:\d\d", 25)
        check("Gọi video P2P kết nối qua signaling Worker", True)

        cfgA = A.evaluate("window.__cfg")
        urls = [u for c in cfgA for s in c.get("iceServers", []) for u in (s["urls"] if isinstance(s["urls"], list) else [s["urls"]])]
        users = [s.get("username") for c in cfgA for s in c.get("iceServers", [])]
        check("RTCPeerConnection nhận iceServers do server cấp (TURN Cloudflare)", any("turn.cloudflare.com:3478" in u for u in urls) and "u" in users, str(urls))
        check("Đã lọc URL cổng 53", not any(":53" in u and "5349" not in u for u in urls))
        check("Vẫn còn STUN dự phòng của Google", any("stun.l.google.com" in u for u in urls))

        A.locator('button[aria-label="Kết thúc cuộc gọi"]').click()
        wait_re(B, r"Cuộc gọi video đã kết thúc", 8)

        # --- thu nhỏ B: tin nhắn mới KHÔNG được coi là đã xem ---
        B.locator('button[title="Thu nhỏ"]').click(); time.sleep(1.2)
        wins, states = wm_states()
        check("B đã thu nhỏ (window manager báo HIDDEN)", any("HIDDEN" in s for s in states))
        A.fill("textarea", "tin khi B đang thu nhỏ")
        A.press("textarea", "Enter")
        time.sleep(2.5)
        txt = A.evaluate("document.body.innerText")
        last = txt[txt.index("tin khi B đang thu nhỏ"):]
        check("B thu nhỏ: A chưa thấy 'Đã xem' cho tin mới", "Đã xem" not in last, repr(last[:60]))
        check("B thu nhỏ: A vẫn thấy 'Đã nhận' (đã chuyển tới máy B)", "Đã nhận" in last or "Đã gửi" in last, repr(last[:80]))
        # khôi phục B
        hidden_win = [w for w, s in zip(wins, states) if "HIDDEN" in s][0]
        subprocess.run(["xdotool", "windowmap", hidden_win], env=ENV)
        subprocess.run(["xdotool", "windowactivate", hidden_win], env=ENV)
        wait_re(A, r"tin khi B đang thu nhỏ[\s\S]*Đã xem", 8)
        check("Khôi phục B: A thấy 'Đã xem'", True)

        # --- Rời phòng ---
        B.get_by_role("button", name="Rời phòng").click()
        A.wait_for_selector("text=Lan đã rời phòng", timeout=8000)
        check("Rời phòng: bên kia nhận peer:left qua Worker", True)

    failed = [n for n, ok in results if not ok]
    print(f"\n==== {len(results) - len(failed)}/{len(results)} PASS ====")
    sys.exit(1 if failed else 0)

try:
    main()
except Exception as e:
    print("EXCEPTION:", type(e).__name__, str(e)[:500])
    print("so far:", [(n, ok) for n, ok in results])
    sys.exit(2)
