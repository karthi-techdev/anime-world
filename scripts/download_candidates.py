import urllib.request
import os
import sys

BASE_URL = "https://huggingface.co/datasets/Linzhan/Mixamo-Animations-Characters/resolve/main/animation"
OUT_DIR = "scripts/anim_candidates"
os.makedirs(OUT_DIR, exist_ok=True)

CANDIDATES = [
    # Idles
    "Breathing_Idle.fbx",
    "Standing_Idle.fbx",
    "Idle.fbx",
    
    # Walks
    "Walking.fbx",
    "Standard_Walk.fbx",
    "Walk.fbx",
    
    # Runs
    "Running.fbx",
    "Fast_Run.fbx",
    "Sprint.fbx",
    
    # Jumps (Idle / Standing Jump)
    "Standing_Jump.fbx",
    "Jumping.fbx",
    "Jump.fbx",
    
    # Jumps (Walk Jump / Forward Jump)
    "Forward_Jump.fbx",
    "Jump_Forward.fbx",
    "Standing_Jump_Running.fbx",
    
    # Jumps (Running Jump)
    "Running_Jump.fbx",
    "Running_Jump_2.fbx",
    
    # Sitting
    "Sitting_Idle.fbx",
    "Sitting.fbx",
    "Sitting_2.fbx",
    
    # Sleeping / Laying
    "Sleeping_Idle.fbx",
    "Laying_Sleeping.fbx",
    "Laying_Idle.fbx",
    
    # Crouch
    "Crouch_Idle.fbx",
    "Crouch_Walking.fbx",
    "Crouched_Walking.fbx",
]

print(f"Downloading {len(CANDIDATES)} candidates into {OUT_DIR}...")
for fname in CANDIDATES:
    target = os.path.join(OUT_DIR, fname)
    if os.path.exists(target) and os.path.getsize(target) > 10000:
        print(f"  [OK] {fname} already cached ({os.path.getsize(target)} bytes)")
        continue
    url = f"{BASE_URL}/{fname}"
    try:
        urllib.request.urlretrieve(url, target)
        print(f"  [DOWNLOADED] {fname} ({os.path.getsize(target)} bytes)")
    except Exception as e:
        print(f"  [FAILED] {fname}: {e}")

print("Done downloading candidates.")
