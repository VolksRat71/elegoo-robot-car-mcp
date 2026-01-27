"""YOLOv8 object detection wrapper."""
from ultralytics import YOLO
from PIL import Image


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

    def detect(
        self, image: Image.Image, confidence_threshold: float = 0.25
    ) -> dict:
        """
        Detect objects in image.

        Args:
            image: PIL Image to analyze
            confidence_threshold: Minimum confidence for detections (0-1)

        Returns:
            dict with:
              - detected_objects: list of {label, bearing_deg, confidence, bbox}
              - count: number of objects detected
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

        return {
            "detected_objects": detected_objects,
            "count": len(detected_objects),
        }
