import sys, time, subprocess
from playwright.sync_api import sync_playwright

results = []
def check(name, cond, extra=""):
    results.append((name, bool(cond))); print(("PASS" if cond else "FAIL"), "-", name, extra)

def electron_count():
    out = subprocess.run(["pgrep", "-xc", "electron"], capture_output=True, text=True).stdout.strip()
    return int(out or 0)

with sync_playwright() as p:
    B = p.chromium.connect_over_cdp("http://127.0.0.1:9223").contexts[0].pages[0]
    w0 = B.evaluate("() => window.outerWidth")
    B.locator('button[title="Phóng to"]').click(); time.sleep(1.2)
    check("Phóng to: đổi nút thành Khôi phục", B.locator('button[title="Khôi phục"]').count() == 1)
    w1 = B.evaluate("() => window.outerWidth")
    check("Phóng to: cửa sổ thực sự lớn hơn", w1 > w0, f"({w0} -> {w1})")
    B.locator('button[title="Khôi phục"]').click(); time.sleep(1.2)
    check("Khôi phục: nút trở lại Phóng to", B.locator('button[title="Phóng to"]').count() == 1)
    w2 = B.evaluate("() => window.outerWidth")
    check("Khôi phục: kích thước về cũ", abs(w2 - w0) < 4, f"({w2} vs {w0})")

    # Double-click thanh tiêu đề để phóng to (hành vi chuẩn Windows)
    B.locator("div.app-drag").first.dblclick(position={"x": 400, "y": 12}); time.sleep(1.0)
    check("Double-click titlebar phóng to cửa sổ", B.locator('button[title="Khôi phục"]').count() == 1)
    B.locator('button[title="Khôi phục"]').click(); time.sleep(0.8)

    B.locator('button[title="Thu nhỏ"]').click(); time.sleep(1.2)
    import subprocess
    wins = subprocess.run("xwininfo -root -tree | grep -i winchat | awk '{print $1}'", shell=True, capture_output=True, text=True, env={"DISPLAY": ":99", "PATH": "/usr/bin:/bin"}).stdout.split()
    states = [subprocess.run(["xprop", "-id", w, "_NET_WM_STATE"], capture_output=True, text=True, env={"DISPLAY": ":99", "PATH": "/usr/bin:/bin"}).stdout for w in wins]
    hidden = any("_NET_WM_STATE_HIDDEN" in st for st in states)
    check("Thu nhỏ: cửa sổ bị ẩn/minimize", hidden)

    n_before = electron_count()
    try:
        # cửa sổ đang minimize, khôi phục bằng IPC không có -> dùng xdotool nếu có, ngược lại bỏ qua phần Đóng
        pass
    finally:
        pass

failed = [n for n, ok in results if not ok]
print(f"\n==== {len(results) - len(failed)}/{len(results)} PASS ====")
sys.exit(1 if failed else 0)
