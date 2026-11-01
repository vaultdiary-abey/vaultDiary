#!/usr/bin/env python3
"""Vault Diary offline recovery.

Decrypts a downloaded VaultDiary folder (or Vault Diary backup zips, or Google Drive's
"Download" zips of the folder) into plain files:

    OUTPUT/entries/<YYYY-MM-DD>/<title>-<id>.md
    OUTPUT/files/<id>-<original name>

Needs Python 3.9+ and two packages:  pip install cryptography argon2-cffi

Usage:
    python3 recover.py ~/Downloads/VaultDiary -o ~/VaultDiary-recovered
    python3 recover.py backup.zip -o out --words        # use the 24 recovery words

The passphrase / words are asked for interactively. For automation they can be passed in the
VAULTDIARY_PASSPHRASE or VAULTDIARY_WORDS environment variables.

The file format is documented in FORMAT.md. This script deliberately mirrors the export layout
of recovery.html; a test checks both produce identical files from the committed fixture.
"""

import argparse
import base64
import getpass
import hashlib
import json
import os
import re
import struct
import sys
import unicodedata
import zipfile

try:
    from argon2.low_level import Type, hash_secret_raw
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
except ImportError:  # pragma: no cover
    sys.stderr.write("Missing packages. Run:  pip install cryptography argon2-cffi\n")
    sys.exit(2)

MAGIC = b"VDV1"
IV_LENGTH = 12
TAG_LENGTH = 16
CHUNK_OVERHEAD = IV_LENGTH + TAG_LENGTH
MAX_HEADER_LENGTH = 64 * 1024
MAX_CHUNK_SIZE = 64 * 1024 * 1024
KINDS = ("entry", "file", "index")
ID_RE = re.compile(r"^[0-9a-f]{32}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
VAULT_FORMAT = "vaultdiary-vault"
ARGON2_BOUNDS = {"memoryKiB": (8192, 1048576), "iterations": (1, 32), "parallelism": (1, 16)}

# Whitespace exactly as JavaScript's String.prototype.trim and RegExp \s see it.
JS_WS = "\t\n\v\f\r    -     　﻿"
JS_TRIM_RE = re.compile("^[" + JS_WS + "]+|[" + JS_WS + "]+$")

# BIP39 English wordlist (https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt).
WORDLIST_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
WORDLIST = """
abandon ability able about above absent absorb abstract absurd abuse access accident account
accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict
address adjust admit adult advance advice aerobic affair afford afraid again age agent agree
ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha
already also alter always amateur amazing among amount amused analyst anchor ancient anger angle
angry animal ankle announce annual another answer antenna antique anxiety any apart apology
appear apple approve april arch arctic area arena argue arm armed armor army around arrange
arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma
athlete atom attack attend attitude attract auction audit august aunt author auto autumn average
avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance
balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean
beauty because become beef before begin behave behind believe below belt bench benefit best
betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame
blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb
bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass
brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother
brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst
bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp
can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo
carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause
caution cave ceiling celery cement census century cereal certain chair chalk champion change
chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney
choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap
clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth
cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color
column combine come comfort comic common company concert conduct confirm congress connect
consider control convince cook cool copper copy coral core corn correct cost cotton couch
country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy
cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise
crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion
custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris
decade december decide decline decorate decrease deer defense define defy degree delay deliver
demand demise denial dentist deny depart depend deposit depth deputy derive describe desert
design desk despair destroy detail detect develop device devote diagram dial diamond diary dice
diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease
dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll
dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream
dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf
dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate
effort egg eight either elbow elder electric elegant element elephant elevator elite else embark
embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy
enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry
envelope episode equal equip era erase erode erosion error erupt escape essay essence estate
eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse
execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose
express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family
famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february
federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film
filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame
flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil
fold follow food foot force forest forget fork fortune forum forward fossil foster found fox
fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny
furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas
gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle
ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue
goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape
grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt
guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk
hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint
hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse
hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt
husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense
immune impact impose improve impulse inch include income increase index indicate indoor industry
infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry
insane insect inside inspire install intact interest into invest invite involve iron island
isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey
joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind
kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake
lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader
leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson
letter level liar liberty library license life lift light like limb limit link lion liquid list
little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love
loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main
major make mammal man manage mandate mango mansion manual maple marble march margin marine
market marriage mask mass master match material math matrix matter maximum maze meadow mean
measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry
mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle
mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey
monster month moon moral more morning mosquito mother motion motor mountain mouse move movie
much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive
name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest
net network neutral never news next nice night noble noise nominee noodle normal north nose
notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure
observe obtain obvious occur ocean october odor off offer office often oil okay old olive
olympic omit once one onion online only open opera opinion oppose option orange orbit orchard
order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven
over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther
paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment
peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet
phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe
pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet
point polar pole police pond pony pool popular portion position possible post potato pottery
poverty powder power practice praise predict prefer prepare present pretty prevent price pride
primary print priority prison private prize problem process produce profit program project
promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin
punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter
question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp
ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall
receive recipe record recycle reduce reflect reform refuse region regret regular reject relax
release relief rely remain remember remind remove render renew rent reopen repair repeat replace
report require rescue resemble resist resource response result retire retreat return reunion
reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple
risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate
rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad
salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan
scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea
search season seat second secret section security seed seek segment select sell seminar senior
sense sentence series service session settle setup seven shadow shaft shallow share shed shell
sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug
shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since
sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep
slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack
snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve
someone song soon sorry sort soul sound soup source south space spare spatial spawn speak
special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport
spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp
stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool
story stove strategy street strike strong struggle student stuff stumble style subject submit
subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply
supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm
swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail
talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term
test text thank that theme then theory there they thing this thought three thrive throw thumb
thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today
toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic
topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic
tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim
trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel
turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware
uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until
unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless
usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle
velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious
victory video view village vintage violin virtual virus visa visit visual vital vivid vocal
voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior
wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird
welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win
window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool
word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young
youth zebra zero zone zoo
""".split()


class RecoveryError(Exception):
    """A file is damaged, modified, truncated or from a different vault."""


class WrongSecret(Exception):
    """The passphrase or recovery words do not open this vault."""


def _check_wordlist():
    digest = hashlib.sha256(("\n".join(WORDLIST) + "\n").encode()).hexdigest()
    if len(WORDLIST) != 2048 or digest != WORDLIST_SHA256:
        raise SystemExit("Internal error: the embedded BIP39 wordlist is corrupted.")


_check_wordlist()
WORD_INDEX = {w: i for i, w in enumerate(WORDLIST)}


def js_trim(s):
    return JS_TRIM_RE.sub("", s)


# ---------------------------------------------------------------------------------------------
# Inputs: folders, loose files and zips are all turned into (label, size, opener) items.


class Item:
    def __init__(self, label, size, opener):
        self.label = label
        self.size = size
        self.open = opener

    def read_all(self):
        with self.open() as f:
            return f.read()

    def startswith_magic(self):
        if self.size < 4:
            return False
        with self.open() as f:
            return f.read(4) == MAGIC


def gather(sources):
    items = []
    for src in sources:
        if os.path.isdir(src):
            for root, _dirs, files in os.walk(src):
                for name in sorted(files):
                    items.extend(_file_items(os.path.join(root, name)))
        elif os.path.isfile(src):
            items.extend(_file_items(src))
        else:
            raise SystemExit(f"Not found: {src}")
    return items


def _file_items(path):
    if path.lower().endswith(".zip"):
        zf = zipfile.ZipFile(path)
        out = []
        for info in zf.infolist():
            if info.is_dir():
                continue
            out.append(
                Item(f"{path}/{info.filename}", info.file_size, lambda i=info, z=zf: z.open(i))
            )
        return out
    return [Item(path, os.path.getsize(path), lambda p=path: open(p, "rb"))]


# ---------------------------------------------------------------------------------------------
# Keys


def b64(s):
    return base64.b64decode(s, validate=True)


def mk_aad(vault_id, kind):
    return f"VDV1/mk/{vault_id}/{kind}".encode()


def parse_vault(data):
    try:
        v = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(v, dict) or v.get("format") != VAULT_FORMAT:
        return None
    if v.get("v") != 1:
        raise RecoveryError(f"Unsupported vault version {v.get('v')!r}")
    if not isinstance(v.get("vaultId"), str) or not ID_RE.match(v["vaultId"]):
        raise RecoveryError("vault.json has an invalid vaultId")
    if not isinstance(v.get("wrappers"), list):
        raise RecoveryError("vault.json has no key wrappers")
    return v


def _wrapper(vault, kind):
    for w in vault["wrappers"]:
        if isinstance(w, dict) and w.get("type") == kind:
            return w
    raise RecoveryError(f"vault.json has no {kind} wrapper")


def _unwrap_mk(kek, wrapper, aad):
    try:
        raw = AESGCM(kek).decrypt(b64(wrapper["iv"]), b64(wrapper["ct"]), aad)
    except (InvalidTag, ValueError, KeyError):
        return None
    return raw if len(raw) == 32 else None


def unwrap_with_passphrase(vault, passphrase):
    w = _wrapper(vault, "passphrase")
    kdf = w["kdf"]
    if kdf.get("name") != "argon2id" or kdf.get("version") != 19:
        raise RecoveryError("Unsupported KDF")
    for field, (lo, hi) in ARGON2_BOUNDS.items():
        value = kdf.get(field)
        if not isinstance(value, int) or not lo <= value <= hi:
            raise RecoveryError(f"Argon2 {field} out of range")
    if not passphrase:
        raise WrongSecret("Wrong passphrase.")
    kek = hash_secret_raw(
        secret=unicodedata.normalize("NFC", passphrase).encode("utf-8"),
        salt=b64(kdf["salt"]),
        time_cost=kdf["iterations"],
        memory_cost=kdf["memoryKiB"],
        parallelism=kdf["parallelism"],
        hash_len=32,
        type=Type.ID,
        version=19,
    )
    raw = _unwrap_mk(kek, w, mk_aad(vault["vaultId"], "passphrase"))
    if raw is None:
        raise WrongSecret("Wrong passphrase.")
    return raw


def normalise_words(text):
    words = [w for w in re.split(r"[^a-z]+", unicodedata.normalize("NFKD", text).lower()) if w]
    out = []
    for w in words:
        if w not in WORD_INDEX and len(w) >= 4:
            matches = [x for x in WORDLIST if x.startswith(w[:4])]
            if len(matches) == 1 and matches[0].startswith(w):
                w = matches[0]
        out.append(w)
    return out


def words_to_entropy(text):
    words = normalise_words(text)
    if len(words) != 24:
        raise WrongSecret(f"Expected 24 recovery words, got {len(words)}.")
    unknown = [w for w in words if w not in WORD_INDEX]
    if unknown:
        raise WrongSecret("Not a recovery word: " + ", ".join(unknown[:3]))
    bits = 0
    for w in words:
        bits = (bits << 11) | WORD_INDEX[w]
    data = bits.to_bytes(33, "big")
    entropy, checksum = data[:32], data[32]
    if hashlib.sha256(entropy).digest()[0] != checksum:
        raise WrongSecret("These words are not a valid recovery phrase (checksum failed).")
    return entropy


def unwrap_with_words(vault, words):
    w = _wrapper(vault, "recovery")
    kdf = w["kdf"]
    if kdf.get("name") != "hkdf-sha256":
        raise RecoveryError("Unsupported recovery KDF")
    entropy = words_to_entropy(words)
    kek = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b64(kdf["salt"]),
        info=kdf["info"].encode("utf-8"),
    ).derive(entropy)
    raw = _unwrap_mk(kek, w, mk_aad(vault["vaultId"], "recovery"))
    if raw is None:
        raise WrongSecret("These recovery words do not belong to this vault.")
    return raw


# ---------------------------------------------------------------------------------------------
# VDV1 container


def chunk_count_for(size, chunk_size):
    return max(1, -(-size // chunk_size))


def _is_uint(n):
    return isinstance(n, int) and not isinstance(n, bool) and n >= 0


def read_header(f, total_size):
    """Reads magic + header from an open file positioned at 0. Returns the header dict."""
    pre = f.read(8)
    if len(pre) < 8 or pre[:4] != MAGIC:
        raise RecoveryError("not a Vault Diary file (bad magic)")
    (hlen,) = struct.unpack(">I", pre[4:8])
    if hlen < 2 or hlen > MAX_HEADER_LENGTH:
        raise RecoveryError("invalid header length")
    raw = f.read(hlen)
    if len(raw) != hlen:
        raise RecoveryError("file is truncated (header)")
    try:
        h = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise RecoveryError("header is not valid JSON")
    if not isinstance(h, dict) or h.get("v") != 1 or h.get("alg") != "A256GCM":
        raise RecoveryError("unsupported format version or algorithm")
    if h.get("kind") not in KINDS or not isinstance(h.get("id"), str) or not ID_RE.match(h["id"]):
        raise RecoveryError("invalid kind or id in header")
    cs, size = h.get("chunkSize"), h.get("size")
    if not _is_uint(cs) or not 1 <= cs <= MAX_CHUNK_SIZE or not _is_uint(size):
        raise RecoveryError("invalid chunk size or plaintext size")
    if h.get("chunkCount") != chunk_count_for(size, cs):
        raise RecoveryError("chunk count does not match size")
    key = h.get("key")
    if not isinstance(key, dict) or not isinstance(key.get("iv"), str) or not isinstance(key.get("ct"), str):
        raise RecoveryError("missing wrapped file key")
    expected = 8 + hlen + size + h["chunkCount"] * CHUNK_OVERHEAD
    if total_size < expected:
        raise RecoveryError("file is truncated")
    if total_size > expected:
        raise RecoveryError("unexpected data after the last chunk")
    return h


def decrypt_stream(mk, item, write, expected_kind=None):
    """Decrypts item chunk by chunk, passing plaintext to write(). Returns the header."""
    with item.open() as f:
        h = read_header(f, item.size)
        if expected_kind and h["kind"] != expected_kind:
            raise RecoveryError(f"expected a {expected_kind} file, found {h['kind']}")
        try:
            file_key = AESGCM(mk).decrypt(
                b64(h["key"]["iv"]),
                b64(h["key"]["ct"]),
                f"VDV1/filekey/{h['kind']}/{h['id']}".encode(),
            )
        except (InvalidTag, ValueError):
            raise RecoveryError(
                "could not unwrap the file key: another vault, or the header was modified"
            )
        if len(file_key) != 32:
            raise RecoveryError("bad file key")
        aes = AESGCM(file_key)
        n = h["chunkCount"]
        for index in range(n):
            last = index == n - 1
            plain_len = h["size"] - index * h["chunkSize"] if last else h["chunkSize"]
            chunk = f.read(plain_len + CHUNK_OVERHEAD)
            if len(chunk) != plain_len + CHUNK_OVERHEAD:
                raise RecoveryError("file is truncated")
            aad = f"VDV1/chunk/{h['id']}/{index}/{1 if last else 0}".encode()
            try:
                write(aes.decrypt(chunk[:IV_LENGTH], chunk[IV_LENGTH:], aad))
            except InvalidTag:
                raise RecoveryError(
                    f"chunk {index} failed authentication: the file was modified, reordered or truncated"
                )
        if f.read(1):
            raise RecoveryError("unexpected data after the last chunk")
    return h


def decrypt_bytes(mk, item, expected_kind=None):
    parts = []
    h = decrypt_stream(mk, item, parts.append, expected_kind)
    return h, b"".join(parts)


# ---------------------------------------------------------------------------------------------
# Entries and the export layout (kept identical to src/recovery/export.ts)


def parse_entry(raw, expected_id):
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not ID_RE.match(raw["id"]):
        raise RecoveryError("entry has an invalid id")
    if raw["id"] != expected_id:
        raise RecoveryError("entry id does not match its file")
    if not isinstance(raw.get("date"), str) or not DATE_RE.match(raw["date"]):
        raise RecoveryError("entry has an invalid date")

    def s(v, default=""):
        return v if isinstance(v, str) else default

    mood = raw.get("mood")
    if isinstance(mood, bool) or not isinstance(mood, (int, float)) or mood not in (1, 2, 3, 4, 5):
        mood = None
    else:
        mood = int(mood)
    attachments = []
    for a in raw.get("attachments") if isinstance(raw.get("attachments"), list) else []:
        if isinstance(a, dict) and isinstance(a.get("fileId"), str) and ID_RE.match(a["fileId"]):
            size = a.get("size")
            attachments.append(
                {
                    **a,  # fields written by newer versions are kept
                    "fileId": a["fileId"],
                    "name": s(a.get("name"), "file"),
                    "mime": s(a.get("mime"), "application/octet-stream"),
                    "size": size if isinstance(size, (int, float)) and not isinstance(size, bool) else 0,
                }
            )
    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
    return {
        **raw,  # fields written by newer versions are kept
        "id": raw["id"],
        "date": raw["date"],
        "createdAt": s(raw.get("createdAt")),
        "updatedAt": s(raw.get("updatedAt")),
        "title": s(raw.get("title")),
        "body": s(raw.get("body")),
        "tags": [t for t in tags if isinstance(t, str)],
        "mood": mood,
        "attachments": attachments,
    }


def display_title(e):
    title = js_trim(e["title"])
    if title:
        return title
    text = js_trim(re.sub(r"[#>*_`~\[\]()!-]", " ", e["body"]))
    first = next((line for line in text.split("\n") if js_trim(line)), "")
    return js_trim(js_trim(first)[:60]) or "Untitled"


def slugify(title):
    ascii_ = "".join(
        c for c in unicodedata.normalize("NFKD", title) if 0x20 <= ord(c) <= 0x7E
    ).lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_).strip("-")[:50].rstrip("-")
    return slug or "untitled"


def safe_file_name(name):
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", name)
    cleaned = re.sub("^[" + JS_WS + ".]+|[" + JS_WS + ".]+$", "", cleaned)
    return cleaned[:120] or "file"


def entry_path(e):
    return f"entries/{e['date']}/{slugify(display_title(e))}-{e['id'][:8]}.md"


def attachment_path(file_id, name):
    return f"files/{file_id[:8]}-{safe_file_name(name)}"


def orphan_path(file_id):
    return f"files/{file_id[:8]}-unreferenced.bin"


def _num(n):
    return str(int(n)) if float(n).is_integer() else repr(n)


def entry_to_markdown(e, available):
    dumps = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    lines = [
        "---",
        f"id: {e['id']}",
        f"date: {e['date']}",
        f"title: {dumps(e['title'])}",
        f"created: {e['createdAt']}",
        f"updated: {e['updatedAt']}",
        f"mood: {e['mood'] if e['mood'] is not None else 'null'}",
        f"tags: {dumps(e['tags'])}",
        "---",
        "",
        f"# {display_title(e)}",
        "",
    ]
    if e["body"]:
        lines += [e["body"].replace("\r\n", "\n"), ""]
    if e["attachments"]:
        lines += ["## Attachments", ""]
        for a in e["attachments"]:
            note = f"{_num(a['size'])} bytes" if available(a["fileId"]) else "missing from this copy"
            label = re.sub(r"[\[\]]", "", a["name"])
            lines.append(f"- [{label}](<../../{attachment_path(a['fileId'], a['name'])}>) ({note})")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------------------------


def recover(sources, out_dir, secret, use_words=False, log=print):
    items = gather(sources)
    problems = []
    vaults, containers = [], []
    for item in items:
        try:
            if item.label.lower().endswith(".json") and item.size < 1024 * 1024:
                v = parse_vault(item.read_all())
                if v is not None and v not in vaults:
                    vaults.append(v)
            elif item.startswith_magic():
                with item.open() as f:
                    h = read_header(f, item.size)
                containers.append((item, h))
        except (RecoveryError, OSError, zipfile.BadZipFile) as exc:
            problems.append(f"{item.label}: {exc}")
    if not vaults:
        raise SystemExit("No vault.json found in the given sources.")
    if len({v["vaultId"] for v in vaults}) > 1:
        raise SystemExit("The sources contain more than one different vault.")

    mk, last_error = None, None
    for v in vaults:
        try:
            mk = unwrap_with_words(v, secret) if use_words else unwrap_with_passphrase(v, secret)
            break
        except WrongSecret as exc:
            last_error = exc
    if mk is None:
        raise last_error

    entries = {}
    files = {}
    for item, h in containers:
        if h["kind"] == "entry":
            try:
                _, plain = decrypt_bytes(mk, item, "entry")
                e = parse_entry(json.loads(plain.decode("utf-8")), h["id"])
            except (RecoveryError, ValueError, UnicodeDecodeError) as exc:
                problems.append(f"{item.label}: {exc}")
                continue
            old = entries.get(e["id"])
            if old is None or old["updatedAt"] < e["updatedAt"]:
                entries[e["id"]] = e
        elif h["kind"] == "file":
            files.setdefault(h["id"], []).append(item)

    ordered = sorted(entries.values(), key=lambda e: (e["date"], e["createdAt"], e["id"]), reverse=True)
    named = {}
    for e in reversed(ordered):
        for a in e["attachments"]:
            named.setdefault(a["fileId"], attachment_path(a["fileId"], a["name"]))

    written_files = set()
    for file_id, candidates in files.items():
        dest = os.path.join(out_dir, named.get(file_id, orphan_path(file_id)))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        errors = []
        for item in candidates:
            tmp = dest + ".partial"
            try:
                with open(tmp, "wb") as out:
                    decrypt_stream(mk, item, out.write, "file")
                os.replace(tmp, dest)
                written_files.add(file_id)
                break
            except (RecoveryError, OSError) as exc:
                errors.append(f"{item.label}: {exc}")
                if os.path.exists(tmp):
                    os.remove(tmp)
        if file_id not in written_files:
            problems.extend(errors)

    for e in ordered:
        dest = os.path.join(out_dir, entry_path(e))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8", newline="") as out:
            out.write(entry_to_markdown(e, lambda fid: fid in written_files))

    for file_id, path in named.items():
        if file_id not in written_files:
            problems.append(f"Attachment {path} is missing from the given sources.")

    log(f"Recovered {len(ordered)} entries and {len(written_files)} files into {out_dir}")
    return ordered, written_files, problems


def main(argv=None):
    p = argparse.ArgumentParser(description="Decrypt a Vault Diary folder or backup into plain files.")
    p.add_argument("sources", nargs="+", help="VaultDiary folder(s), backup zip(s) or Drive download zip(s)")
    p.add_argument("-o", "--output", required=True, help="output folder (created if missing)")
    p.add_argument("--words", action="store_true", help="unlock with the 24 recovery words instead")
    p.add_argument("--force", action="store_true", help="allow writing into a non-empty output folder")
    args = p.parse_args(argv)

    if os.path.isdir(args.output) and os.listdir(args.output) and not args.force:
        p.error(f"{args.output} is not empty (use --force to write into it anyway)")
    os.makedirs(args.output, exist_ok=True)

    if args.words:
        secret = os.environ.get("VAULTDIARY_WORDS") or input("Recovery words (24): ")
    else:
        secret = os.environ.get("VAULTDIARY_PASSPHRASE") or getpass.getpass("Passphrase: ")
    try:
        _, _, problems = recover(args.sources, args.output, secret, args.words)
    except WrongSecret as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    except RecoveryError as exc:
        sys.stderr.write(f"Error: {exc}\n")
        return 2
    if problems:
        sys.stderr.write(f"\n{len(problems)} problem(s):\n")
        for line in problems:
            sys.stderr.write(f"  - {line}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
