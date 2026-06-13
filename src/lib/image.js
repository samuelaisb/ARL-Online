const MAX_IMAGE_DIMENSION = 1200;
const JPEG_QUALITY = 0.8;
const WEBP_QUALITY = 0.8;

function canvasToDataUrl(canvas) {
  const webp = canvas.toDataURL('image/webp', WEBP_QUALITY);
  if (webp.startsWith('data:image/webp')) {
    return webp;
  }

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

export function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Please choose an image file.'));
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      const img = new Image();

      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');

        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Could not process the image.'));
          return;
        }

        context.drawImage(img, 0, 0, width, height);
        resolve(canvasToDataUrl(canvas));
      };

      img.onerror = () => reject(new Error('Could not read the image.'));
      img.src = reader.result;
    };

    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}
