"""One `codex app-server` process, two threads, a turn on each at the same time.
Usage: python3 -I scripts/codex-app-server-two-threads.py <cwd> <model>   (prints what it saw; no secrets)"""
import json, subprocess, sys, time

cwd, model = sys.argv[1], sys.argv[2]
p = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=cwd)
n = 0
def send(method, params, notify=False):
    global n
    msg = {"method": method, "params": params}
    if not notify:
        n += 1; msg["id"] = n
    p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()
    return n
def wait_for(pred, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        line = p.stdout.readline()
        if not line: return None
        m = json.loads(line)
        if pred(m): return m
send("initialize", {"clientInfo": {"name": "two_threads", "version": "0.1.0"}}); wait_for(lambda m: m.get("id") == 1)
send("initialized", {}, notify=True)
threads = []
for _ in range(2):
    i = send("thread/start", {"cwd": cwd, "model": model})
    threads.append(wait_for(lambda m, i=i: m.get("id") == i)["result"]["thread"]["id"])
print("threads:", len(set(threads)), "in pid", p.pid)
for t, word in zip(threads, ["apple", "pear"]):
    send("turn/start", {"threadId": t, "input": [{"type": "text", "text": f"Reply with the single word {word}."}], "effort": "low"})
done = {}
started = time.time()
while len(done) < 2 and time.time() - started < 120:
    m = wait_for(lambda m: m.get("method") in ("item/completed", "turn/completed"))
    if m is None: break
    prm = m["params"]
    if m["method"] == "item/completed" and prm["item"]["type"] == "agentMessage":
        done.setdefault(prm["threadId"], prm["item"]["text"])
for t in threads:
    print("thread", threads.index(t), "answered:", done.get(t))
p.stdin.close(); p.wait(timeout=20)
print("exit", p.returncode)
