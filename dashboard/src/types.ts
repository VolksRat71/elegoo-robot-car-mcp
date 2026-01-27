export interface DetectedObject {
  label: string;
  bearing_deg: number;
  confidence: number;
  bbox?: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
}

export interface DepthResult {
  center_depth: number;
  depth_zones: {
    left: number;
    center: number;
    right: number;
  };
  image_size: {
    width: number;
    height: number;
  };
}

export interface WorldState {
  schema_version: string;
  timestamp_ms: number;
  autonomy_state: 'IDLE' | 'EXECUTING' | 'AVOIDING' | 'RECOVERING' | 'RELOCALIZING' | 'STUCK';
  last_action: string;
  stuck_counter: number;
  geometry: {
    front_min_mm: number;
    scan_bins_mm: number[];
    best_gap: { bearing_deg: number; width_mm: number } | null;
  };
  semantics: {
    detected_objects: DetectedObject[];
    current_place_tags: string[];
  };
  map_summary: {
    current_place: string | null;
    nearby_places: string[];
    unexplored_frontiers: number;
    loop_closure: {
      candidates: { place_id: string; score: number }[];
      confidence: number;
    };
  };
  confidence: {
    localization: number;
    safety: number;
    loop_closure: number;
  };
  health: {
    link_rtt_ms: number;
    command_age_ms: number;
    dropped_frames: number;
    last_heartbeat_ms: number;
    battery_voltage: number;
    queue_depth: number;
  };
}

export interface Snapshot {
  timestamp: number;
  camera_image?: string; // base64
  depth_image?: string; // base64 colormap
  annotated_image?: string; // base64 with bounding boxes
  depth?: DepthResult;
  detection?: {
    detected_objects: DetectedObject[];
    count: number;
  };
  world_state: WorldState;
  robot_connected: boolean;
  vision_available: boolean;
}

export interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
}
