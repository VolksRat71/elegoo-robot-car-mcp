// Re-export stock client as default robot client
export {
  StockRobotClient,
  getStockRobotClient as getRobotClient,
  type RobotResponse,
  type RobotStatus,
} from "./robot-client-stock.js";
