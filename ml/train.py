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
NUM_CLASSES = 38

# ── Load dataset ───────────────────────────────────────────────────────────────
print("Downloading PlantVillage via TensorFlow Datasets …")
(train_raw, val_raw), info = tfds.load(
    "plant_village",
    split=["train[:80%]", "train[80%:]"],
    as_supervised=True,
    with_info=True,
)

# Verify and write labels.json (overwrites the committed placeholder if class order changed)
class_names = info.features["label"].names
assert len(class_names) == NUM_CLASSES, f"Expected {NUM_CLASSES} classes, got {len(class_names)}"
readable = [
    name.replace("___", " ").replace("_", " ").replace("(", "(").strip()
    for name in class_names
]
with open(LABELS_PATH, "w") as f:
    json.dump(readable, f, indent=2)
print(f"Labels written to {LABELS_PATH}")


# ── Pre-processing & augmentation ─────────────────────────────────────────────
def preprocess(image, label):
    image = tf.image.resize(image, [IMG_SIZE, IMG_SIZE])
    image = preprocess_input(image)  # scales to [-1, 1]
    return image, label


def augment(image, label):
    image, label = preprocess(image, label)
    image = tf.image.random_flip_left_right(image)
    image = tf.image.random_brightness(image, max_delta=0.2)
    return image, label


AUTOTUNE = tf.data.AUTOTUNE

train_ds = (
    train_raw
    .map(augment, num_parallel_calls=AUTOTUNE)
    .shuffle(1000)
    .batch(BATCH_SIZE)
    .prefetch(AUTOTUNE)
)

val_ds = (
    val_raw
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

# ── Phase B: fine-tune last 30 layers ─────────────────────────────────────────
print("\nPhase B — fine-tuning last 30 layers of MobileNetV2 …")
base.trainable = True
for layer in base.layers[:-30]:
    layer.trainable = False

model.compile(
    optimizer=tf.keras.optimizers.Adam(1e-5),
    loss="sparse_categorical_crossentropy",
    metrics=["accuracy"],
)
model.fit(train_ds, validation_data=val_ds, epochs=5)

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
