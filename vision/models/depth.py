"""MiDaS depth estimation wrapper."""
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

    def estimate(self, image: Image.Image) -> dict:
        """
        Estimate relative depth from image.

        Args:
            image: PIL Image to analyze

        Returns:
            dict with:
              - center_depth: depth at image center (0-1 normalized, higher = closer)
              - depth_zones: {"left": float, "center": float, "right": float}
              - image_size: {"width": int, "height": int}
        """
        # Convert PIL to numpy
        img_np = np.array(image)

        # Apply transforms
        input_batch = self.transform(img_np).to(self.device)

        with torch.no_grad():
            prediction = self.model(input_batch)

            # Resize to original resolution
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
            depth_normalized = (depth_map - depth_min) / (depth_max - depth_min)
        else:
            depth_normalized = np.zeros_like(depth_map)

        # Calculate zone depths (left third, center third, right third)
        h, w = depth_normalized.shape
        third_w = w // 3

        depth_zones = {
            "left": float(np.mean(depth_normalized[:, :third_w])),
            "center": float(np.mean(depth_normalized[:, third_w : 2 * third_w])),
            "right": float(np.mean(depth_normalized[:, 2 * third_w :])),
        }

        # Center depth (middle 20% of image)
        center_region = depth_normalized[
            int(h * 0.4) : int(h * 0.6), int(w * 0.4) : int(w * 0.6)
        ]
        center_depth = float(np.mean(center_region))

        return {
            "center_depth": round(center_depth, 3),
            "depth_zones": {k: round(v, 3) for k, v in depth_zones.items()},
            "image_size": {"width": w, "height": h},
        }
