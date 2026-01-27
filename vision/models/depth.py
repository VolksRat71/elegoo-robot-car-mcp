"""MiDaS depth estimation wrapper."""
import base64
import io
import torch
import numpy as np
from PIL import Image


class DepthEstimator:
    def __init__(self, model_type: str = "MiDaS_small"):
        """
        Initialize MiDaS depth estimator.

        Args:
            model_type: One of "DPT_Large", "DPT_Hybrid", "MiDaS_small"
                       Use "MiDaS_small" for faster inference on robot
        """
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model_type = model_type

        # Load MiDaS model from torch hub
        self.model = torch.hub.load("intel-isl/MiDaS", model_type)
        self.model.to(self.device)
        self.model.eval()

        # Load transforms
        midas_transforms = torch.hub.load("intel-isl/MiDaS", "transforms")
        if model_type in ["DPT_Large", "DPT_Hybrid"]:
            self.transform = midas_transforms.dpt_transform
        else:
            self.transform = midas_transforms.small_transform

    def _get_depth_map(self, image: Image.Image) -> np.ndarray:
        """Run MiDaS inference and return normalized depth map."""
        img_np = np.array(image)
        input_batch = self.transform(img_np).to(self.device)

        with torch.no_grad():
            prediction = self.model(input_batch)
            prediction = torch.nn.functional.interpolate(
                prediction.unsqueeze(1),
                size=img_np.shape[:2],
                mode="bicubic",
                align_corners=False,
            ).squeeze()

        depth_map = prediction.cpu().numpy()

        # Normalize to 0-1 range (higher = closer)
        depth_min = depth_map.min()
        depth_max = depth_map.max()
        if depth_max > depth_min:
            return (depth_map - depth_min) / (depth_max - depth_min)
        return np.zeros_like(depth_map)

    def _create_colormap(self, depth_normalized: np.ndarray) -> str:
        """Create a colormap visualization and return as base64 JPEG."""
        # Apply colormap: closer (high values) = warm colors, far = cool
        # Using a simple cyan-to-red gradient
        depth_uint8 = (depth_normalized * 255).astype(np.uint8)

        # Create RGB colormap (blue for far, red for close)
        h, w = depth_uint8.shape
        colormap = np.zeros((h, w, 3), dtype=np.uint8)

        # R channel: high for close objects
        colormap[:, :, 0] = depth_uint8
        # G channel: medium for mid-range
        colormap[:, :, 1] = ((1 - np.abs(depth_normalized - 0.5) * 2) * 180).astype(
            np.uint8
        )
        # B channel: high for far objects
        colormap[:, :, 2] = (255 - depth_uint8)

        # Convert to PIL and encode as base64 JPEG
        img = Image.fromarray(colormap)
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=85)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")

    def estimate(self, image: Image.Image, include_image: bool = False) -> dict:
        """
        Estimate relative depth from image.

        Args:
            image: PIL Image to analyze
            include_image: If True, include base64 colormap image in result

        Returns:
            dict with:
              - center_depth: depth at image center (0-1 normalized, higher = closer)
              - depth_zones: {"left": float, "center": float, "right": float}
              - image_size: {"width": int, "height": int}
              - depth_image: (optional) base64 JPEG colormap visualization
        """
        depth_normalized = self._get_depth_map(image)

        h, w = depth_normalized.shape

        # === ROI: Only use the middle vertical band ===
        # Ignore top 30% (ceiling, windows, lights - often misestimated)
        # Ignore bottom 25% (floor - always reads as close)
        # This focuses on the "decision zone" where obstacles actually matter
        roi_top = int(h * 0.30)
        roi_bottom = int(h * 0.75)
        depth_roi = depth_normalized[roi_top:roi_bottom, :]

        # Calculate zone depths (left third, center third, right third)
        # Use 75th percentile instead of mean - more robust to noise
        # (median was too conservative, mean too sensitive to outliers)
        third_w = w // 3

        depth_zones = {
            "left": float(np.percentile(depth_roi[:, :third_w], 75)),
            "center": float(np.percentile(depth_roi[:, third_w : 2 * third_w], 75)),
            "right": float(np.percentile(depth_roi[:, 2 * third_w :], 75)),
        }

        # Center depth for danger detection (middle region of ROI)
        center_region = depth_roi[
            :, int(w * 0.35) : int(w * 0.65)
        ]
        center_depth = float(np.percentile(center_region, 75))

        result = {
            "center_depth": round(center_depth, 3),
            "depth_zones": {k: round(v, 3) for k, v in depth_zones.items()},
            "image_size": {"width": w, "height": h},
        }

        if include_image:
            result["depth_image"] = self._create_colormap(depth_normalized)

        return result
