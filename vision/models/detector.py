"""YOLOv8 object detection wrapper."""
import base64
import io
from ultralytics import YOLO
from PIL import Image, ImageDraw, ImageFont


class ObjectDetector:
    def __init__(self, model_size: str = "yolov8n"):
        """
        Initialize YOLOv8 detector.

        Args:
            model_size: One of "yolov8n", "yolov8s", "yolov8m", "yolov8l", "yolov8x"
                       Use "yolov8n" (nano) for faster inference on robot
        """
        self.model = YOLO(f"{model_size}.pt")
        self.model_size = model_size

        # Color palette for bounding boxes (RGB)
        self.colors = [
            (0, 255, 255),  # Cyan
            (255, 165, 0),  # Orange
            (0, 255, 127),  # Spring green
            (255, 0, 127),  # Rose
            (127, 255, 0),  # Chartreuse
            (255, 255, 0),  # Yellow
        ]

    def _draw_annotations(
        self, image: Image.Image, detected_objects: list
    ) -> str:
        """Draw bounding boxes and labels on image, return as base64 JPEG."""
        # Make a copy to draw on
        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)

        # Try to load a font, fall back to default
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 14)
        except (IOError, OSError):
            try:
                font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 14)
            except (IOError, OSError):
                font = ImageFont.load_default()

        for i, obj in enumerate(detected_objects):
            color = self.colors[i % len(self.colors)]
            bbox = obj["bbox"]
            label = f"{obj['label']} {obj['confidence']:.0%}"

            # Draw bounding box
            draw.rectangle(
                [bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]],
                outline=color,
                width=2,
            )

            # Draw label background
            text_bbox = draw.textbbox((bbox["x1"], bbox["y1"] - 18), label, font=font)
            draw.rectangle(text_bbox, fill=color)

            # Draw label text
            draw.text(
                (bbox["x1"], bbox["y1"] - 18),
                label,
                fill=(0, 0, 0),
                font=font,
            )

        # Encode as base64 JPEG
        buffer = io.BytesIO()
        annotated.save(buffer, format="JPEG", quality=85)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")

    def detect(
        self, image: Image.Image, confidence_threshold: float = 0.25, include_image: bool = False
    ) -> dict:
        """
        Detect objects in image.

        Args:
            image: PIL Image to analyze
            confidence_threshold: Minimum confidence for detections (0-1)
            include_image: If True, include base64 annotated image in result

        Returns:
            dict with:
              - detected_objects: list of {label, bearing_deg, confidence, bbox}
              - count: number of objects detected
              - annotated_image: (optional) base64 JPEG with bounding boxes
        """
        # Run inference
        results = self.model(image, conf=confidence_threshold, verbose=False)

        detected_objects = []
        img_width = image.width

        for result in results:
            boxes = result.boxes
            for box in boxes:
                # Get class name and confidence
                cls_id = int(box.cls[0])
                label = result.names[cls_id]
                confidence = float(box.conf[0])

                # Get bounding box (x1, y1, x2, y2)
                x1, y1, x2, y2 = box.xyxy[0].tolist()

                # Calculate bearing from image center
                # Assume ~60 degree horizontal FOV for ESP32 camera
                box_center_x = (x1 + x2) / 2
                relative_x = (box_center_x - img_width / 2) / (img_width / 2)
                bearing_deg = relative_x * 30  # Half of 60 degree FOV

                detected_objects.append(
                    {
                        "label": label,
                        "bearing_deg": round(bearing_deg, 1),
                        "confidence": round(confidence, 3),
                        "bbox": {
                            "x1": round(x1, 1),
                            "y1": round(y1, 1),
                            "x2": round(x2, 1),
                            "y2": round(y2, 1),
                        },
                    }
                )

        result = {
            "detected_objects": detected_objects,
            "count": len(detected_objects),
        }

        if include_image and detected_objects:
            result["annotated_image"] = self._draw_annotations(image, detected_objects)

        return result
