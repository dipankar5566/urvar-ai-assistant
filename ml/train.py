"""
Train MobileNetV2 on PlantVillage (TF Datasets) and export to TF.js graph model.

Usage:
    pip install -r requirements.txt
    python train.py

Outputs:
    ml/models/plant_village_saved_model/  — Keras SavedModel
    ml/models/tfjs_crop_classifier/       — TF.js graph model (load in Node.js)
    ml/labels.json                         — 38-class index → name mapping (already committed)
"""

import json
import os
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

# Five-Crop-Diseases — read from local path (download once via Kaggle website or CLI)
FIVE_CROP_DIR = os.path.join(SCRIPT_DIR, "data", "five-crop-diseases")
if not os.path.isdir(os.path.join(FIVE_CROP_DIR, "train")):
    raise FileNotFoundError(
        f"Five-crop-diseases dataset not found at {FIVE_CROP_DIR}/train/\n"
        "Download from https://www.kaggle.com/datasets/shubham2703/five-crop-diseases-dataset "
        "and extract to ml/data/five-crop-diseases/ so that ml/data/five-crop-diseases/train/ exists."
    )

five_crop_train_ds = tf.keras.utils.image_dataset_from_directory(
    os.path.join(FIVE_CROP_DIR, "train"),
    image_size=(IMG_SIZE, IMG_SIZE),
    batch_size=None,
    label_mode="int",
    shuffle=False,
)
five_crop_val_ds = tf.keras.utils.image_dataset_from_directory(
    os.path.join(FIVE_CROP_DIR, "validation"),
    image_size=(IMG_SIZE, IMG_SIZE),
    batch_size=None,
    label_mode="int",
    shuffle=False,
)

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

five_crop_labels = list(five_crop_train_ds.class_names)  # indices 46–(46+N-1)

all_labels = pv_labels + beans_labels + cassava_labels + five_crop_labels
NUM_CLASSES = len(all_labels)

with open(LABELS_PATH, "w") as f:
    json.dump(all_labels, f, indent=2)
print(f"Labels written to {LABELS_PATH} ({NUM_CLASSES} classes)")
print(f"PlantVillage: {len(pv_labels)}, Beans: {len(beans_labels)}, "
      f"Cassava: {len(cassava_labels)}, FiveCrop: {len(five_crop_labels)}")


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
BEANS_OFFSET     = len(pv_labels)                                           # 38
CASSAVA_OFFSET   = len(pv_labels) + len(beans_labels)                       # 41
FIVE_CROP_OFFSET = len(pv_labels) + len(beans_labels) + len(cassava_labels) # 46

def cast_pv(image, label):
    return tf.cast(image, tf.float32), label

def remap_beans(image, label):
    return tf.cast(image, tf.float32), label + BEANS_OFFSET

def remap_cassava(image, label):
    return tf.cast(image, tf.float32), label + CASSAVA_OFFSET

def remap_five_crop(image, label):
    return image, tf.cast(label, tf.int64) + FIVE_CROP_OFFSET

AUTOTUNE = tf.data.AUTOTUNE

pv_train_cast            = pv_train_raw.map(cast_pv,           num_parallel_calls=AUTOTUNE)
pv_val_cast              = pv_val_raw.map(cast_pv,             num_parallel_calls=AUTOTUNE)
beans_train_remapped     = beans_train_raw.map(remap_beans,     num_parallel_calls=AUTOTUNE)
beans_val_remapped       = beans_val_raw.map(remap_beans,       num_parallel_calls=AUTOTUNE)
cassava_train_remapped   = cassava_train_raw.map(remap_cassava, num_parallel_calls=AUTOTUNE)
cassava_val_remapped     = cassava_val_raw.map(remap_cassava,   num_parallel_calls=AUTOTUNE)
five_crop_train_remapped = five_crop_train_ds.map(remap_five_crop, num_parallel_calls=AUTOTUNE)
five_crop_val_remapped   = five_crop_val_ds.map(remap_five_crop,   num_parallel_calls=AUTOTUNE)

combined_train_raw = (
    pv_train_cast
    .concatenate(beans_train_remapped)
    .concatenate(cassava_train_remapped)
    .concatenate(five_crop_train_remapped)
)
combined_val_raw = (
    pv_val_cast
    .concatenate(beans_val_remapped)
    .concatenate(cassava_val_remapped)
    .concatenate(five_crop_val_remapped)
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
