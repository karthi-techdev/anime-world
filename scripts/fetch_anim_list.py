import urllib.request
import json
import re

all_files = []
url = "https://huggingface.co/api/datasets/Linzhan/Mixamo-Animations-Characters/tree/main/animation"

while url:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        files = [item["path"].replace("animation/", "") for item in data if item["type"] == "file"]
        all_files.extend(files)
        link = resp.headers.get("Link", "")
        next_url = None
        match = re.search(r'<([^>]+)>;\s*rel="next"', link)
        if match:
            next_url = match.group(1)
        url = next_url

print(f"Total animation files: {len(all_files)}")
with open("scripts/mixamo_catalog.json", "w") as f:
    json.dump(all_files, f, indent=2)

for query in ["idle", "walk", "run", "jump", "sit", "sleep", "lie", "prone", "crouch"]:
    matches = [x for x in all_files if query in x.lower()]
    print(f"\n--- {query.upper()} ({len(matches)}) ---")
    for m in matches[:10]:
        print(" ", m)
