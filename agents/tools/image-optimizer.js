import sharp from "sharp";

export async function optimizeCropImage(base64Data, options = {}) {
  const {
    size = 256,
    denoise = true,
    enhance = true,
    colorVariants = true,
    augment = true,
  } = options;

  const buf = Buffer.from(base64Data, "base64");

  // Primary: resize → median noise reduction → normalize contrast → gamma correction
  let primary = sharp(buf).resize(size, size, { fit: "cover", position: "centre" });
  if (denoise) primary = primary.median(3);
  if (enhance) primary = primary.normalize().gamma(1.2);
  const variants = [(await primary.jpeg({ quality: 90 }).toBuffer()).toString("base64")];

  if (colorVariants) {
    // Grayscale — removes color bias; highlights lesion texture and spread pattern
    variants.push(
      (await sharp(buf)
        .resize(size, size, { fit: "cover", position: "centre" })
        .grayscale()
        .normalize()
        .jpeg({ quality: 90 })
        .toBuffer()
      ).toString("base64")
    );

    // Saturation-boosted — approximates HSV S-channel; makes pathogen pigments vivid
    variants.push(
      (await sharp(buf)
        .resize(size, size, { fit: "cover", position: "centre" })
        .modulate({ saturation: 1.8, brightness: 1.05 })
        .normalize()
        .jpeg({ quality: 90 })
        .toBuffer()
      ).toString("base64")
    );
  }

  if (augment) {
    // 90° rotation — different perspective on lesion distribution across the leaf
    variants.push(
      (await sharp(buf)
        .resize(size, size, { fit: "cover", position: "centre" })
        .rotate(90)
        .median(3)
        .normalize()
        .jpeg({ quality: 85 })
        .toBuffer()
      ).toString("base64")
    );

    // Horizontal flip — symmetry check for disease spread directionality
    variants.push(
      (await sharp(buf)
        .resize(size, size, { fit: "cover", position: "centre" })
        .flop()
        .median(3)
        .normalize()
        .jpeg({ quality: 85 })
        .toBuffer()
      ).toString("base64")
    );
  }

  return variants;
}
