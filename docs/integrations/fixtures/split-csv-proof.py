"""Opt-in proof against a disposable local Parley instance with split support."""
import csv
import http.cookiejar
import io
import json
import pathlib
import sys
import urllib.error
import urllib.request

base, output = sys.argv[1:]
if base not in ("http://127.0.0.1:58096", "http://localhost:58096"):
    raise SystemExit("use the dedicated local proof instance on port 58096")


def client():
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )


def request(agent, method, path, body=None, status=200):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        response = agent.open(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        if response.status != status:
            raise RuntimeError(f"{method} {path}: {response.status}, expected {status}")
        if path.endswith("/export.csv"):
            return raw.decode(), dict(response.headers)
        return json.loads(raw) if raw else None


facilitator, member, outsider = client(), client(), client()
for agent, name in ((facilitator, "Proof facilitator"), (member, "Proof member"),
                    (outsider, "Proof outsider")):
    request(agent, "POST", "/api/me", {"name": name}, 201)
space = request(facilitator, "POST", "/api/spaces", {"name": "CSV proof 796"}, 201)
space_path = "/api/orgs/default/spaces/" + space["slug"]
request(member, "POST", space_path + "/join", {"passcode": space["passcode"]}, 204)
room = request(facilitator, "POST", space_path + "/sessions",
               {"kind": "poker", "title": "Split CSV proof", "config": {}}, 201)
room_path = "/api/sessions/" + room["id"]
actions = room_path + "/actions/"
request(facilitator, "POST", actions + "stories", {"title": "Original"}, 204)
state = request(facilitator, "GET", room_path)["state"]
parent = state["stories"][0]["id"]
request(facilitator, "PATCH", actions + "story", {"storyId": parent, "estimate": "13"}, 204)
children = []
for revision, title in enumerate(("API", "UI", "Permissions")):
    child = request(facilitator, "POST", actions + "child",
                    {"parentId": parent, "title": title, "operationId": title,
                     "expectedSplitRevision": revision}, 201)
    children.append(child["storyId"])
for child, estimate in zip(children[:2], ("3", "5")):
    request(facilitator, "PATCH", actions + "story",
            {"storyId": child, "estimate": estimate, "expectedRevision": 0}, 204)
request(facilitator, "POST", actions + "adopt",
        {"parentId": parent, "expectedSplitRevision": 3, "expectedRevision": 1,
         "coverage": "full", "children": dict(zip(children, (1, 1, 0)))}, 204)
state = request(member, "GET", room_path)["state"]
raw, headers = request(member, "GET", room_path + "/export.csv")
rows = list(csv.DictReader(io.StringIO(raw)))
assert len(rows) == 4
assert rows[0]["story_id"] == parent
assert rows[0]["estimate"] == "13" and rows[0]["planning_role"] == "context"
for row, child, estimate in zip(rows[1:], children, ("3", "5", "")):
    assert row["story_id"] == child and row["parent_id"] == parent
    assert row["planning_role"] == "planning" and row["estimate"] == estimate
    story = next(s for s in state["stories"] if s["id"] == child)
    assert story["estimate"] == (estimate or None)
    assert row["content_revision"] == str(story["contentRevision"])
assert headers["Content-Type"] == "text/csv; charset=utf-8"
assert "attachment" in headers["Content-Disposition"]
request(outsider, "GET", room_path + "/export.csv", status=404)
pathlib.Path(output).write_text(raw)
print("PASS: member HTTP CSV matches visible split state; parent 13 retained; children 3/5/blank; outsider 404")
