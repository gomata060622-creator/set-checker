#!/usr/bin/env python3
"""author.json・koheya.json を暗号化して data/ に置く（公開の置き場所に中身が見えないように）。

使い方: python3 tools/encrypt.py 合言葉のファイル 元のjson 出力先.enc
ページ側は同じ合言葉で、PBKDF2(SHA-256, 200000回) → AES-GCM で戻し、gzipを解く。
"""
import base64, gzip, json, os, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

key_file, src, dst = sys.argv[1:4]
secret = open(key_file, encoding="utf-8").read().strip().encode()
raw = open(src, "rb").read()
json.loads(raw.decode("utf-8-sig"))  # 形の確認
salt, iv = os.urandom(16), os.urandom(12)
k = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=200000).derive(secret)
ct = AESGCM(k).encrypt(iv, gzip.compress(raw, 9), None)
b = lambda x: base64.b64encode(x).decode()
with open(dst, "w", encoding="utf-8") as f:
    json.dump({"v": 1, "s": b(salt), "i": b(iv), "d": b(ct)}, f)
print(dst, len(raw), "->", os.path.getsize(dst))
