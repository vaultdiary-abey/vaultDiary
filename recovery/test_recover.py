"""Tests for recover.py against the sample vault written by the app (tests/fixtures/sample-vault).

Run:  python3 -m unittest discover -s recovery -p 'test_*.py' -v
"""

import filecmp
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import recover  # noqa: E402

FIXTURE = os.path.join(HERE, "..", "tests", "fixtures", "sample-vault")
VAULT_DIR = os.path.join(FIXTURE, "VaultDiary")
EXPECTED = os.path.join(FIXTURE, "expected")
with open(os.path.join(FIXTURE, "secrets.json"), encoding="utf-8") as fh:
    SECRETS = json.load(fh)


def tree(root):
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            with open(path, "rb") as fh:
                out[os.path.relpath(path, root)] = fh.read()
    return out


class RecoverTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = os.path.join(self.tmp, "out")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_recover(self, sources, secret=SECRETS["passphrase"], words=False):
        return recover.recover(sources, self.out, secret, words, log=lambda *_: None)

    def assert_matches_expected(self):
        self.assertEqual(tree(self.out), tree(EXPECTED))

    def copy_vault(self):
        dest = os.path.join(self.tmp, "VaultDiary")
        shutil.copytree(VAULT_DIR, dest)
        return dest

    def test_passphrase_folder(self):
        entries, files, problems = self.run_recover([VAULT_DIR])
        self.assertEqual(problems, [])
        self.assertEqual(len(entries), 4)
        self.assertEqual(len(files), 4)
        self.assert_matches_expected()

    def test_recovery_words(self):
        _, _, problems = self.run_recover([VAULT_DIR], SECRETS["recoveryWords"], words=True)
        self.assertEqual(problems, [])
        self.assert_matches_expected()

    def test_recovery_words_prefixes_and_case(self):
        messy = "\n".join(w[:4].upper() for w in SECRETS["recoveryWords"].split())
        _, _, problems = self.run_recover([VAULT_DIR], messy, words=True)
        self.assertEqual(problems, [])

    def test_drive_style_deflate_zip(self):
        zpath = os.path.join(self.tmp, "VaultDiary-20260101T000000Z-001.zip")
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
            for base, _dirs, files in os.walk(VAULT_DIR):
                for name in files:
                    full = os.path.join(base, name)
                    zf.write(full, os.path.join("VaultDiary", os.path.relpath(full, VAULT_DIR)))
        _, _, problems = self.run_recover([zpath])
        self.assertEqual(problems, [])
        self.assert_matches_expected()

    def test_wrong_passphrase(self):
        with self.assertRaises(recover.WrongSecret) as cm:
            self.run_recover([VAULT_DIR], "not the passphrase")
        self.assertEqual(str(cm.exception), "Wrong passphrase.")
        with self.assertRaises(recover.WrongSecret):
            self.run_recover([VAULT_DIR], "")

    def test_wrong_recovery_words(self):
        valid_other = " ".join(["abandon"] * 23 + ["art"])
        with self.assertRaises(recover.WrongSecret) as cm:
            self.run_recover([VAULT_DIR], valid_other, words=True)
        self.assertIn("do not belong", str(cm.exception))
        words = SECRETS["recoveryWords"].split()
        words[0], words[1] = words[1], words[0]
        if words != SECRETS["recoveryWords"].split():
            with self.assertRaises(recover.WrongSecret):
                self.run_recover([VAULT_DIR], " ".join(words), words=True)
        with self.assertRaises(recover.WrongSecret) as cm:
            self.run_recover([VAULT_DIR], "zoo zoo", words=True)
        self.assertIn("24", str(cm.exception))

    def _largest_file(self, vault):
        files_dir = os.path.join(vault, "files")
        name = max(os.listdir(files_dir), key=lambda n: os.path.getsize(os.path.join(files_dir, n)))
        return os.path.join(files_dir, name)

    def _chunk_layout(self, path):
        with open(path, "rb") as fh:
            data = fh.read()
        hlen = int.from_bytes(data[4:8], "big")
        header = json.loads(data[8 : 8 + hlen])
        return data, 8 + hlen, header["chunkSize"] + recover.CHUNK_OVERHEAD

    def test_tampered_chunk_fails_loudly(self):
        vault = self.copy_vault()
        path = self._largest_file(vault)
        data, offset, stride = self._chunk_layout(path)
        data = bytearray(data)
        data[offset + stride + 50] ^= 1
        with open(path, "wb") as fh:
            fh.write(data)
        entries, files, problems = self.run_recover([vault])
        self.assertEqual(len(files), 3)
        self.assertTrue(any("chunk 1 failed authentication" in p for p in problems), problems)
        self.assertFalse(any(n.endswith(".partial") for n in os.listdir(os.path.join(self.out, "files"))))

    def test_reordered_chunks_fail(self):
        vault = self.copy_vault()
        path = self._largest_file(vault)
        data, offset, stride = self._chunk_layout(path)
        c0, c1 = data[offset : offset + stride], data[offset + stride : offset + 2 * stride]
        with open(path, "wb") as fh:
            fh.write(data[:offset] + c1 + c0 + data[offset + 2 * stride :])
        _, _, problems = self.run_recover([vault])
        self.assertTrue(any("chunk 0 failed authentication" in p for p in problems), problems)

    def test_truncated_file_fails(self):
        vault = self.copy_vault()
        path = self._largest_file(vault)
        data, _, stride = self._chunk_layout(path)
        with open(path, "wb") as fh:
            fh.write(data[:-stride])
        _, _, problems = self.run_recover([vault])
        self.assertTrue(any("truncated" in p for p in problems), problems)
        self.assertTrue(any("missing from the given sources" in p for p in problems), problems)

    def test_cli(self):
        os.environ["VAULTDIARY_PASSPHRASE"] = SECRETS["passphrase"]
        try:
            self.assertEqual(recover.main([VAULT_DIR, "-o", self.out]), 0)
        finally:
            del os.environ["VAULTDIARY_PASSPHRASE"]
        self.assertTrue(filecmp.dircmp(self.out, EXPECTED).diff_files == [])


class ParseEntryTest(unittest.TestCase):
    def test_keeps_unknown_entry_and_attachment_fields(self):
        eid, fid, tid = "a" * 32, "b" * 32, "c" * 32
        raw = {
            "id": eid,
            "date": "2026-11-01",
            "createdAt": "2026-11-01T08:00:00.000Z",
            "updatedAt": "2026-11-01T08:00:00.000Z",
            "title": "Newer writer",
            "body": "text",
            "tags": ["a"],
            "mood": 3,
            "location": {"lat": 1},
            "attachments": [
                {"fileId": fid, "name": "clip.mp4", "mime": "video/mp4", "size": 10, "thumbFileId": tid}
            ],
        }
        self.assertEqual(recover.parse_entry(json.loads(json.dumps(raw)), eid), raw)

    def test_still_normalises_known_fields(self):
        eid, fid = "a" * 32, "b" * 32
        e = recover.parse_entry(
            {"id": eid, "date": "2026-11-01", "mood": 9, "tags": ["x", 4],
             "attachments": [{"fileId": fid, "size": "big", "extra": 1}, {}]},
            eid,
        )
        self.assertIsNone(e["mood"])
        self.assertEqual(e["tags"], ["x"])
        self.assertEqual(
            e["attachments"],
            [{"fileId": fid, "name": "file", "mime": "application/octet-stream", "size": 0, "extra": 1}],
        )


if __name__ == "__main__":
    unittest.main()
