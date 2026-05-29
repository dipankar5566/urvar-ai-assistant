"""
Train MobileNetV2 on PlantVillage (TF Datasets) and export to TF.js graph model.

Usage:
    pip install -r requirements.txt
    python train.py

Outputs:
    ml/models/plant_village_saved_model/  — Keras SavedModel
    ml/models/tfjs_crop_classifier/       — TF.js graph model (load in Node.js)
    ml/labels.json                         — class index → name mapping (95 classes across 9 datasets)

Datasets:
    PlantVillage    — 38 classes (TF Datasets)
    Beans           — 3 classes  (TF Datasets)
    Cassava         — 5 classes  (TF Datasets)
    FiveCrop        — 17 classes (Kaggle, manual download)
    Jute            — 2 classes  (Kaggle srkuhin/jute-leaf-disease-detection, originals only)
    IndianCrop      — 16 new classes; overlapping crop/disease dirs mapped to existing indices
    CCMT            — 11 new classes; overlapping Maize/Tomato/Cassava dirs mapped to existing indices
    PlantDoc        — 28 classes mapped to existing labels (field-captured, adds robustness)
    RiceNutrient    — 3 new classes (Kaggle guy007/nutrientdeficiencysymptomsinrice)
"""

import glob
import json
import os
import random
import subprocess

import tensorflow as tf
import tensorflow_datasets as tfds
from tensorflow.keras.applications import MobileNetV2
from tensorflow.keras.applications.mobilenet_v2 import preprocess_input
from tensorflow.keras.layers import Dense, GlobalAveragePooling2D
from tensorflow.keras.models import Model

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SAVED_MODEL_DIR = os.path.join(SCRIPT_DIR, "models", "plant_village_saved_model")
TFJS_MODEL_DIR = os.path.join(SCRIPT_DIR, "models", "tfjs_crop_classifier")
LABELS_PATH = os.path.join(SCRIPT_DIR, "labels.json")
PLANTDOC_BASE    = os.path.join(SCRIPT_DIR, "data", "PlantDoc-Dataset")
JUTE_BASE        = os.path.join(SCRIPT_DIR, "data", "jute-leaf-disease", "Jute Leaf Disease Detection")
INDIAN_CROP_BASE = os.path.join(SCRIPT_DIR, "data", "indian-crop-disease", "Crop Dataset")
CCMT_BASE        = os.path.join(SCRIPT_DIR, "data", "ccmt")
RICE_NUTRIENT_BASE = os.path.join(SCRIPT_DIR, "data", "rice-nutrient-deficiency", "rice_plant_lacks_nutrients")

IMG_SIZE = 224
BATCH_SIZE = 32

# ── Load datasets ──────────────────────────────────────────────────────────────
print("Loading datasets …")

(pv_train_raw, pv_val_raw), pv_info = tfds.load(
    "plant_village",
    split=["train[:80%]", "train[80%:]"],
    as_supervised=True,
    with_info=True,
)

(beans_train_raw, beans_val_raw), beans_info = tfds.load(
    "beans",
    split=["train", "validation"],
    as_supervised=True,
    with_info=True,
)

(cassava_train_raw, cassava_val_raw), cassava_info = tfds.load(
    "cassava",
    split=["train[:80%]", "train[80%:]"],
    as_supervised=True,
    with_info=True,
)

# Five-Crop-Diseases — flat structure: Crop___Disease/<crop>/<disease>/<images>
# No pre-built split; we do 80/20 here with a fixed seed.
FIVE_CROP_BASE = os.path.join(
    SCRIPT_DIR, "data", "five-crop-diseases",
    "Crop Diseases Dataset", "Crop Diseases", "Crop___Disease",
)
if not os.path.isdir(FIVE_CROP_BASE):
    raise FileNotFoundError(
        f"Five-crop-diseases dataset not found at {FIVE_CROP_BASE}\n"
        "Download from https://www.kaggle.com/datasets/shubham2703/five-crop-diseases-dataset "
        "and extract to ml/data/five-crop-diseases/"
    )

# Collect leaf disease directories (depth: crop_dir/disease_dir)
_disease_dirs = sorted([
    d
    for crop_dir in sorted(glob.glob(os.path.join(FIVE_CROP_BASE, "*")))
    if os.path.isdir(crop_dir)
    for d in sorted(glob.glob(os.path.join(crop_dir, "*")))
    if os.path.isdir(d)
])
five_crop_class_names = [os.path.basename(d) for d in _disease_dirs]

_all_paths, _all_labels_fc = [], []
for _idx, _d in enumerate(_disease_dirs):
    for _fname in sorted(os.listdir(_d)):
        if os.path.splitext(_fname)[1].lower() in {".jpg", ".jpeg", ".png"}:
            _all_paths.append(os.path.join(_d, _fname))
            _all_labels_fc.append(_idx)

_rng = random.Random(42)
_combined = list(zip(_all_paths, _all_labels_fc))
_rng.shuffle(_combined)
_all_paths, _all_labels_fc = zip(*_combined)

_split = int(0.8 * len(_all_paths))
_fc_train_paths  = list(_all_paths[:_split])
_fc_train_labels = list(_all_labels_fc[:_split])
_fc_val_paths    = list(_all_paths[_split:])
_fc_val_labels   = list(_all_labels_fc[_split:])

print(f"Five-crop classes ({len(five_crop_class_names)}): {five_crop_class_names}")
print(f"Five-crop images — train: {len(_fc_train_paths)}, val: {len(_fc_val_paths)}")

# PlantDoc — field-captured images mapped to existing PlantVillage label indices.
# Uses its own train/test split; does not add new classes.
PLANTDOC_CLASS_MAP = {
    "Apple Scab Leaf":                        0,   # Apple Apple scab
    "Apple leaf":                             3,   # Apple healthy
    "Apple rust leaf":                        2,   # Apple Cedar apple rust
    "Bell_pepper leaf":                      19,   # Pepper, bell healthy
    "Bell_pepper leaf spot":                 18,   # Pepper, bell Bacterial spot
    "Blueberry leaf":                         4,   # Blueberry healthy
    "Cherry leaf":                            5,   # Cherry healthy
    "Corn Gray leaf spot":                    7,   # Corn Cercospora leaf spot Gray leaf spot
    "Corn leaf blight":                      10,   # Corn Northern Leaf Blight
    "Corn rust leaf":                         8,   # Corn Common rust
    "Peach leaf":                            17,   # Peach healthy
    "Potato leaf early blight":              20,   # Potato Early blight
    "Potato leaf late blight":               22,   # Potato Late blight
    "Raspberry leaf":                        23,   # Raspberry healthy
    "Soyabean leaf":                         24,   # Soybean healthy
    "Squash Powdery mildew leaf":            25,   # Squash Powdery mildew
    "Strawberry leaf":                       26,   # Strawberry healthy
    "Tomato Early blight leaf":              29,   # Tomato Early blight
    "Tomato Septoria leaf spot":             33,   # Tomato Septoria leaf spot
    "Tomato leaf":                           30,   # Tomato healthy
    "Tomato leaf bacterial spot":            28,   # Tomato Bacterial spot
    "Tomato leaf late blight":               31,   # Tomato Late blight
    "Tomato leaf mosaic virus":              36,   # Tomato Tomato mosaic virus
    "Tomato leaf yellow virus":              37,   # Tomato Tomato Yellow Leaf Curl Virus
    "Tomato mold leaf":                      32,   # Tomato Leaf Mold
    "Tomato two spotted spider mites leaf":  34,   # Tomato Spider mites
    "grape leaf":                            13,   # Grape healthy
    "grape leaf black rot":                  11,   # Grape Black rot
}


def _load_plantdoc_split(split_dir):
    paths, labels = [], []
    for class_name, label_idx in PLANTDOC_CLASS_MAP.items():
        class_dir = os.path.join(split_dir, class_name)
        if not os.path.isdir(class_dir):
            continue
        for fname in sorted(os.listdir(class_dir)):
            if os.path.splitext(fname)[1].lower() in {".jpg", ".jpeg", ".png"}:
                paths.append(os.path.join(class_dir, fname))
                labels.append(label_idx)
    return paths, labels


_pd_train_paths, _pd_train_labels = _load_plantdoc_split(os.path.join(PLANTDOC_BASE, "train"))
_pd_val_paths,   _pd_val_labels   = _load_plantdoc_split(os.path.join(PLANTDOC_BASE, "test"))
print(f"PlantDoc images — train: {len(_pd_train_paths)}, val: {len(_pd_val_paths)}")

# Jute — 2 classes (Healthy=0, Cercospora leaf spot=1); original images only.
# Augmented copies (filename contains ".jpg_") are excluded to prevent data leakage.
# Class folders: JUTE_BASE/0  and  JUTE_BASE/1
JUTE_CLASS_NAMES = ["Jute Healthy", "Jute Cercospora Leaf Spot"]

_jute_all_paths, _jute_all_labels = [], []
for local_idx, class_dir_name in enumerate(["0", "1"]):
    class_dir = os.path.join(JUTE_BASE, class_dir_name)
    if not os.path.isdir(class_dir):
        raise FileNotFoundError(
            f"Jute dataset not found at {class_dir}\n"
            "Download: kaggle datasets download -d srkuhin/jute-leaf-disease-detection -p ml/data/jute-leaf-disease --unzip"
        )
    for fname in sorted(os.listdir(class_dir)):
        ext = os.path.splitext(fname)[1].lower()
        if ext in {".jpg", ".jpeg", ".png"} and ".jpg_" not in fname:
            _jute_all_paths.append(os.path.join(class_dir, fname))
            _jute_all_labels.append(local_idx)

_jute_rng = random.Random(42)
_jute_combined = list(zip(_jute_all_paths, _jute_all_labels))
_jute_rng.shuffle(_jute_combined)
_jute_all_paths, _jute_all_labels = zip(*_jute_combined)

_jute_split = int(0.8 * len(_jute_all_paths))
_jute_train_paths  = list(_jute_all_paths[:_jute_split])
_jute_train_labels = list(_jute_all_labels[:_jute_split])
_jute_val_paths    = list(_jute_all_paths[_jute_split:])
_jute_val_labels   = list(_jute_all_labels[_jute_split:])
print(f"Jute images (originals) — train: {len(_jute_train_paths)}, val: {len(_jute_val_paths)}")

# IndianCrop — 6 crops; overlapping classes mapped to existing indices,
# 16 new classes appended starting at index 65.
# FiveCrop index reference (offset 46): Rice___Brown_Spot=53, Rice___Healthy=54,
#   Wheat___Healthy=58, Wheat___Yellow_Rust=59, sugarcane_Healthy=61, sugarcane_RedRot=62.
INDIAN_CROP_NEW_CLASSES = [
    "Coffee Healthy",             # 65
    "Coffee Rust",                # 66
    "Coffee Leaf Miner",          # 67
    "Cotton Healthy",             # 68
    "Cotton Aphids",              # 69
    "Cotton Army Worm",           # 70
    "Cotton Bacterial Blight",    # 71
    "Cotton Powdery Mildew",      # 72
    "Cotton Target Spot",         # 73
    "Jute Golden Mosaic",         # 74
    "Rice Bacterial Leaf Blight", # 75
    "Rice Leaf Smut",             # 76
    "Sugarcane Mosaic",           # 77
    "Sugarcane Rust",             # 78
    "Sugarcane Yellow",           # 79
    "Wheat Septoria",             # 80
]

# Keys are paths relative to INDIAN_CROP_BASE; values are global label indices.
INDIAN_CROP_DIR_MAP = {
    "coffee/healthy":                           65,  # Coffee Healthy (new)
    "coffee/Disease/rust":                      66,  # Coffee Rust (new)
    "coffee/Disease/miner":                     67,  # Coffee Leaf Miner (new)
    "cotton/Healthy":                           68,  # Cotton Healthy (new)
    "cotton/Disease/Aphids edited":             69,  # Cotton Aphids (new)
    "cotton/Disease/Army worm edited":          70,  # Cotton Army Worm (new)
    "cotton/Disease/Bacterial Blight edited":   71,  # Cotton Bacterial Blight (new)
    "cotton/Disease/Powdery Mildew Edited":     72,  # Cotton Powdery Mildew (new)
    "cotton/Disease/Target spot edited":        73,  # Cotton Target Spot (new)
    "jute/Healthy":                             63,  # → Jute Healthy (existing)
    "jute/Disease/Cescospora Leaf Spot":        64,  # → Jute Cercospora Leaf Spot (existing)
    "jute/Disease/Golden Mosaic":               74,  # Jute Golden Mosaic (new)
    "rice/Healthy":                             54,  # → Rice___Healthy (FiveCrop)
    "rice/Disease/Brown spot":                  53,  # → Rice___Brown_Spot (FiveCrop)
    "rice/Disease/Bacterial leaf blight":       75,  # Rice Bacterial Leaf Blight (new)
    "rice/Disease/Leaf smut":                   76,  # Rice Leaf Smut (new)
    "sugarcane/Healthy":                        61,  # → sugarcane Healthy (FiveCrop)
    "sugarcane/Disease/RedRot":                 62,  # → sugarcane Red Rot (FiveCrop)
    "sugarcane/Disease/Mosaic":                 77,  # Sugarcane Mosaic (new)
    "sugarcane/Disease/Rust":                   78,  # Sugarcane Rust (new)
    "sugarcane/Disease/Yellow":                 79,  # Sugarcane Yellow (new)
    "wheat/Healthy":                            58,  # → Wheat___Healthy (FiveCrop)
    "wheat/Disease/stripe_rust":                59,  # → Wheat___Yellow_Rust (FiveCrop, same disease)
    "wheat/Disease/septoria":                   80,  # Wheat Septoria (new)
}

_ic_all_paths, _ic_all_labels = [], []
for rel_path, label_idx in INDIAN_CROP_DIR_MAP.items():
    class_dir = os.path.join(INDIAN_CROP_BASE, rel_path)
    if not os.path.isdir(class_dir):
        print(f"Warning: {class_dir} not found, skipping")
        continue
    for fname in sorted(os.listdir(class_dir)):
        if os.path.splitext(fname)[1].lower() in {".jpg", ".jpeg", ".png"}:
            _ic_all_paths.append(os.path.join(class_dir, fname))
            _ic_all_labels.append(label_idx)

_ic_rng = random.Random(42)
_ic_combined = list(zip(_ic_all_paths, _ic_all_labels))
_ic_rng.shuffle(_ic_combined)
_ic_all_paths, _ic_all_labels = zip(*_ic_combined)

_ic_split = int(0.8 * len(_ic_all_paths))
_ic_train_paths  = list(_ic_all_paths[:_ic_split])
_ic_train_labels = list(_ic_all_labels[:_ic_split])
_ic_val_paths    = list(_ic_all_paths[_ic_split:])
_ic_val_labels   = list(_ic_all_labels[_ic_split:])
print(f"IndianCrop images — train: {len(_ic_train_paths)}, val: {len(_ic_val_paths)}")

# CCMT — 22 classes (Cashew ×5, Cassava ×5, Maize ×7, Tomato ×5) from Ghanaian farms.
# Maize healthy/leaf blight/leaf spot → PlantVillage Corn indices.
# Tomato healthy/leaf blight/leaf curl/septoria → PlantVillage Tomato indices.
# Cassava bacterial blight/green mite/healthy/mosaic → TF Datasets Cassava indices.
# 11 new classes appended at indices 81–91.
# Note: "Maize grasshoper" is the exact folder name (dataset typo, not ours).
CCMT_NEW_CLASSES = [
    "Maize Fall Armyworm",      # 81
    "Maize Grasshopper",        # 82
    "Maize Leaf Beetle",        # 83
    "Maize Streak Virus",       # 84
    "Tomato Verticillium Wilt", # 85
    "Cashew Anthracnose",       # 86
    "Cashew Gumosis",           # 87
    "Cashew Healthy",           # 88
    "Cashew Leaf Miner",        # 89
    "Cashew Red Rust",          # 90
    "Cassava Brown Spot",       # 91
]

CCMT_DIR_MAP = {
    # Maize — 3 map to PlantVillage Corn (offset 0); 4 pests/streak are new
    "Maize healthy":              9,  # → Corn healthy (PV)
    "Maize leaf blight":         10,  # → Corn Northern Leaf Blight (PV)
    "Maize leaf spot":            7,  # → Corn Cercospora leaf spot (PV)
    "Maize fall armyworm":       81,  # new
    "Maize grasshoper":          82,  # new (folder has typo — exact match required)
    "Maize leaf beetle":         83,  # new
    "Maize streak virus":        84,  # new
    # Tomato — leaf blight = early blight (leaf-focused disease in tropical conditions)
    "Tomato healthy":            30,  # → Tomato healthy (PV)
    "Tomato leaf blight":        29,  # → Tomato Early blight (PV)
    "Tomato leaf curl":          37,  # → Tomato Yellow Leaf Curl Virus (PV)
    "Tomato septoria leaf spot": 33,  # → Tomato Septoria leaf spot (PV)
    "Tomato verticulium wilt":   85,  # new
    # Cashew — not in any existing dataset
    "Cashew anthracnose":        86,
    "Cashew gumosis":            87,
    "Cashew healthy":            88,
    "Cashew leaf miner":         89,
    "Cashew red rust":           90,
    # Cassava — 4 map to TF Datasets cassava; brown spot ≠ brown streak disease (cbsd)
    "Cassava bacterial blight":  41,  # → Cassava - Cbb (TF)
    "Cassava brown spot":        91,  # new (fungal; different from viral cbsd at index 42)
    "Cassava green mite":        43,  # → Cassava - Cgm (TF)
    "Cassava healthy":           45,  # → Cassava - Healthy (TF)
    "Cassava mosaic":            44,  # → Cassava - Cmd (TF)
}

_ccmt_all_paths, _ccmt_all_labels = [], []
for folder_name, label_idx in CCMT_DIR_MAP.items():
    class_dir = os.path.join(CCMT_BASE, folder_name)
    if not os.path.isdir(class_dir):
        print(f"Warning: CCMT folder not found: {class_dir}")
        continue
    for fname in sorted(os.listdir(class_dir)):
        if os.path.splitext(fname)[1].lower() in {".jpg", ".jpeg", ".png"}:
            _ccmt_all_paths.append(os.path.join(class_dir, fname))
            _ccmt_all_labels.append(label_idx)

_ccmt_rng = random.Random(42)
_ccmt_combined = list(zip(_ccmt_all_paths, _ccmt_all_labels))
_ccmt_rng.shuffle(_ccmt_combined)
_ccmt_all_paths, _ccmt_all_labels = zip(*_ccmt_combined)

_ccmt_split = int(0.8 * len(_ccmt_all_paths))
_ccmt_train_paths  = list(_ccmt_all_paths[:_ccmt_split])
_ccmt_train_labels = list(_ccmt_all_labels[:_ccmt_split])
_ccmt_val_paths    = list(_ccmt_all_paths[_ccmt_split:])
_ccmt_val_labels   = list(_ccmt_all_labels[_ccmt_split:])
print(f"CCMT images — train: {len(_ccmt_train_paths)}, val: {len(_ccmt_val_paths)}")

RICE_NUTRIENT_NEW_CLASSES = [
    "Rice Nitrogen Deficiency",    # 92
    "Rice Phosphorus Deficiency",  # 93
    "Rice Potassium Deficiency",   # 94
]

RICE_NUTRIENT_DIR_MAP = {
    "Nitrogen(N)":   92,
    "Phosphorus(P)": 93,
    "Potassium(K)":  94,
}

_rn_all_paths, _rn_all_labels = [], []
for folder_name, label_idx in RICE_NUTRIENT_DIR_MAP.items():
    class_dir = os.path.join(RICE_NUTRIENT_BASE, folder_name)
    if not os.path.isdir(class_dir):
        print(f"Warning: rice-nutrient folder not found: {class_dir}")
        continue
    for fname in sorted(os.listdir(class_dir)):
        if os.path.splitext(fname)[1].lower() in {".jpg", ".jpeg", ".png"}:
            _rn_all_paths.append(os.path.join(class_dir, fname))
            _rn_all_labels.append(label_idx)

_rn_rng = random.Random(42)
_rn_combined = list(zip(_rn_all_paths, _rn_all_labels))
_rn_rng.shuffle(_rn_combined)
_rn_all_paths, _rn_all_labels = zip(*_rn_combined)

_rn_split = int(0.8 * len(_rn_all_paths))
_rn_train_paths  = list(_rn_all_paths[:_rn_split])
_rn_train_labels = list(_rn_all_labels[:_rn_split])
_rn_val_paths    = list(_rn_all_paths[_rn_split:])
_rn_val_labels   = list(_rn_all_labels[_rn_split:])
print(f"RiceNutrient images — train: {len(_rn_train_paths)}, val: {len(_rn_val_paths)}")

# ── Build merged labels list ───────────────────────────────────────────────────
pv_labels = [
    name.replace("___", " ").replace("_", " ").strip()
    for name in pv_info.features["label"].names
]  # indices 0–37

beans_labels = [
    "Beans - " + name.replace("_", " ").title()
    for name in beans_info.features["label"].names
]  # indices 38–40

cassava_labels = [
    "Cassava - " + name.replace("_", " ").title()
    for name in cassava_info.features["label"].names
]  # indices 41–45

five_crop_labels    = five_crop_class_names   # indices 46–62
jute_labels         = JUTE_CLASS_NAMES        # indices 63–64
indian_crop_labels  = INDIAN_CROP_NEW_CLASSES # indices 65–80
ccmt_labels            = CCMT_NEW_CLASSES           # indices 81–91
rice_nutrient_labels   = RICE_NUTRIENT_NEW_CLASSES  # indices 92–94

all_labels = (pv_labels + beans_labels + cassava_labels + five_crop_labels
              + jute_labels + indian_crop_labels + ccmt_labels + rice_nutrient_labels)
NUM_CLASSES = len(all_labels)

with open(LABELS_PATH, "w") as f:
    json.dump(all_labels, f, indent=2)
print(f"Labels written to {LABELS_PATH} ({NUM_CLASSES} classes)")
print(f"PlantVillage: {len(pv_labels)}, Beans: {len(beans_labels)}, "
      f"Cassava: {len(cassava_labels)}, FiveCrop: {len(five_crop_labels)}, "
      f"Jute: {len(jute_labels)}, IndianCrop new: {len(indian_crop_labels)}, "
      f"CCMT new: {len(ccmt_labels)}, PlantDoc: mapped to existing labels, "
      f"RiceNutrient new: {len(rice_nutrient_labels)}")


# ── Pre-processing & augmentation ─────────────────────────────────────────────
def preprocess(image, label):
    image = tf.image.resize(image, [IMG_SIZE, IMG_SIZE])
    image = preprocess_input(image)  # scales to [-1, 1]
    return image, label


def augment(image, label):
    # Resize first (tf.image.resize returns float32 in [0, 255])
    image = tf.image.resize(image, [IMG_SIZE, IMG_SIZE])

    # Geometric — range-independent
    image = tf.image.random_flip_left_right(image)
    image = tf.image.random_flip_up_down(image)
    k = tf.random.uniform([], minval=0, maxval=4, dtype=tf.int32)
    image = tf.image.rot90(image, k=k)  # 0°, 90°, 180°, or 270°

    # Color ops require [0, 1]; preprocess_input must come after
    image = image / 255.0
    image = tf.image.random_brightness(image, max_delta=0.2)
    image = tf.image.random_contrast(image, lower=0.8, upper=1.2)
    image = tf.image.random_hue(image, max_delta=0.05)
    image = tf.image.random_saturation(image, lower=0.8, upper=1.2)
    image = tf.clip_by_value(image, 0.0, 1.0)
    image = image * 255.0

    # MobileNetV2 normalisation → [-1, 1]
    image = preprocess_input(image)
    return image, label


# ── Label offsets + dtype-normalising remap functions ─────────────────────────
# concatenate() requires identical element specs: (float32, int64) throughout.
# tfds emits (uint8, int64); image_dataset_from_directory emits (float32, int32).
BEANS_OFFSET     = len(pv_labels)                                                            # 38
CASSAVA_OFFSET   = len(pv_labels) + len(beans_labels)                                       # 41
FIVE_CROP_OFFSET = len(pv_labels) + len(beans_labels) + len(cassava_labels)                 # 46
JUTE_OFFSET      = len(pv_labels) + len(beans_labels) + len(cassava_labels) + len(five_crop_labels)  # 63

def cast_pv(image, label):
    return tf.cast(image, tf.float32), label

def remap_beans(image, label):
    return tf.cast(image, tf.float32), label + BEANS_OFFSET

def remap_cassava(image, label):
    return tf.cast(image, tf.float32), label + CASSAVA_OFFSET

def remap_five_crop(image, label):
    return image, tf.cast(label, tf.int64) + FIVE_CROP_OFFSET

def remap_jute(image, label):
    return tf.cast(image, tf.float32), tf.cast(label, tf.int64) + JUTE_OFFSET

def cast_plantdoc(image, label):
    return tf.cast(image, tf.float32), tf.cast(label, tf.int64)

def cast_indian_crop(image, label):
    # Labels are already global indices (no offset needed); just normalise dtypes.
    return tf.cast(image, tf.float32), tf.cast(label, tf.int64)

def cast_ccmt(image, label):
    return tf.cast(image, tf.float32), tf.cast(label, tf.int64)

def cast_rice_nutrient(image, label):
    return tf.cast(image, tf.float32), tf.cast(label, tf.int64)

AUTOTUNE = tf.data.AUTOTUNE


def load_fc_image(path, label):
    img = tf.io.read_file(path)
    img = tf.image.decode_image(img, channels=3, expand_animations=False)
    img = tf.cast(img, tf.float32)
    img = tf.image.resize(img, [IMG_SIZE, IMG_SIZE])
    return img, tf.cast(label, tf.int64)


five_crop_train_ds = (
    tf.data.Dataset.from_tensor_slices((_fc_train_paths, _fc_train_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)
five_crop_val_ds = (
    tf.data.Dataset.from_tensor_slices((_fc_val_paths, _fc_val_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)

plantdoc_train_ds = (
    tf.data.Dataset.from_tensor_slices((_pd_train_paths, _pd_train_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)
plantdoc_val_ds = (
    tf.data.Dataset.from_tensor_slices((_pd_val_paths, _pd_val_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)

jute_train_ds = (
    tf.data.Dataset.from_tensor_slices((_jute_train_paths, _jute_train_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)
jute_val_ds = (
    tf.data.Dataset.from_tensor_slices((_jute_val_paths, _jute_val_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)

indian_crop_train_ds = (
    tf.data.Dataset.from_tensor_slices((_ic_train_paths, _ic_train_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)
indian_crop_val_ds = (
    tf.data.Dataset.from_tensor_slices((_ic_val_paths, _ic_val_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)

ccmt_train_ds = (
    tf.data.Dataset.from_tensor_slices((_ccmt_train_paths, _ccmt_train_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)
ccmt_val_ds = (
    tf.data.Dataset.from_tensor_slices((_ccmt_val_paths, _ccmt_val_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)

rice_nutrient_train_ds = (
    tf.data.Dataset.from_tensor_slices((_rn_train_paths, _rn_train_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)
rice_nutrient_val_ds = (
    tf.data.Dataset.from_tensor_slices((_rn_val_paths, _rn_val_labels))
    .map(load_fc_image, num_parallel_calls=AUTOTUNE)
)

pv_train_cast                = pv_train_raw.map(cast_pv,               num_parallel_calls=AUTOTUNE)
pv_val_cast                  = pv_val_raw.map(cast_pv,                 num_parallel_calls=AUTOTUNE)
beans_train_remapped         = beans_train_raw.map(remap_beans,         num_parallel_calls=AUTOTUNE)
beans_val_remapped           = beans_val_raw.map(remap_beans,           num_parallel_calls=AUTOTUNE)
cassava_train_remapped       = cassava_train_raw.map(remap_cassava,     num_parallel_calls=AUTOTUNE)
cassava_val_remapped         = cassava_val_raw.map(remap_cassava,       num_parallel_calls=AUTOTUNE)
five_crop_train_remapped     = five_crop_train_ds.map(remap_five_crop,  num_parallel_calls=AUTOTUNE)
five_crop_val_remapped       = five_crop_val_ds.map(remap_five_crop,    num_parallel_calls=AUTOTUNE)
plantdoc_train_remapped      = plantdoc_train_ds.map(cast_plantdoc,     num_parallel_calls=AUTOTUNE)
plantdoc_val_remapped        = plantdoc_val_ds.map(cast_plantdoc,       num_parallel_calls=AUTOTUNE)
jute_train_remapped          = jute_train_ds.map(remap_jute,            num_parallel_calls=AUTOTUNE)
jute_val_remapped            = jute_val_ds.map(remap_jute,              num_parallel_calls=AUTOTUNE)
indian_crop_train_remapped   = indian_crop_train_ds.map(cast_indian_crop, num_parallel_calls=AUTOTUNE)
indian_crop_val_remapped     = indian_crop_val_ds.map(cast_indian_crop,   num_parallel_calls=AUTOTUNE)
ccmt_train_remapped          = ccmt_train_ds.map(cast_ccmt,               num_parallel_calls=AUTOTUNE)
ccmt_val_remapped            = ccmt_val_ds.map(cast_ccmt,                 num_parallel_calls=AUTOTUNE)
rice_nutrient_train_remapped = rice_nutrient_train_ds.map(cast_rice_nutrient, num_parallel_calls=AUTOTUNE)
rice_nutrient_val_remapped   = rice_nutrient_val_ds.map(cast_rice_nutrient,   num_parallel_calls=AUTOTUNE)

combined_train_raw = (
    pv_train_cast
    .concatenate(beans_train_remapped)
    .concatenate(cassava_train_remapped)
    .concatenate(five_crop_train_remapped)
    .concatenate(plantdoc_train_remapped)
    .concatenate(jute_train_remapped)
    .concatenate(indian_crop_train_remapped)
    .concatenate(ccmt_train_remapped)
    .concatenate(rice_nutrient_train_remapped)
)
combined_val_raw = (
    pv_val_cast
    .concatenate(beans_val_remapped)
    .concatenate(cassava_val_remapped)
    .concatenate(five_crop_val_remapped)
    .concatenate(plantdoc_val_remapped)
    .concatenate(jute_val_remapped)
    .concatenate(indian_crop_val_remapped)
    .concatenate(ccmt_val_remapped)
    .concatenate(rice_nutrient_val_remapped)
)

train_ds = (
    combined_train_raw
    .map(augment, num_parallel_calls=AUTOTUNE)
    .shuffle(1000)
    .batch(BATCH_SIZE)
    .prefetch(AUTOTUNE)
)

val_ds = (
    combined_val_raw
    .map(preprocess, num_parallel_calls=AUTOTUNE)
    .batch(BATCH_SIZE)
    .prefetch(AUTOTUNE)
)

# ── Build model ────────────────────────────────────────────────────────────────
base = MobileNetV2(include_top=False, weights="imagenet", input_shape=(IMG_SIZE, IMG_SIZE, 3))
base.trainable = False

x = GlobalAveragePooling2D()(base.output)
output = Dense(NUM_CLASSES, activation="softmax")(x)
model = Model(inputs=base.input, outputs=output)

# ── Phase A: train head only ───────────────────────────────────────────────────
print("\nPhase A — training classification head (base frozen) …")
model.compile(
    optimizer=tf.keras.optimizers.Adam(1e-3),
    loss="sparse_categorical_crossentropy",
    metrics=["accuracy"],
)
model.fit(train_ds, validation_data=val_ds, epochs=10)

# ── Phase B: fine-tune last 100 layers ────────────────────────────────────────
print("\nPhase B — fine-tuning last 100 layers of MobileNetV2 …")
base.trainable = True
for layer in base.layers[:-100]:
    layer.trainable = False

model.compile(
    optimizer=tf.keras.optimizers.Adam(1e-5),
    loss="sparse_categorical_crossentropy",
    metrics=["accuracy"],
)
model.fit(train_ds, validation_data=val_ds, epochs=10)

# ── Save as TF SavedModel ──────────────────────────────────────────────────────
os.makedirs(os.path.dirname(SAVED_MODEL_DIR), exist_ok=True)
model.export(SAVED_MODEL_DIR)
print(f"\nSavedModel written to {SAVED_MODEL_DIR}")

# ── Convert to TF.js graph model ───────────────────────────────────────────────
print("\nConverting to TF.js graph model …")
subprocess.run(
    [
        "tensorflowjs_converter",
        "--input_format=tf_saved_model",
        "--output_format=tfjs_graph_model",
        SAVED_MODEL_DIR,
        TFJS_MODEL_DIR,
    ],
    check=True,
)
print(f"TF.js model written to {TFJS_MODEL_DIR}")
print("\nDone. Run `node agents/bot.js` to start the bot with CNN pre-classification.")
