// Connects the agent to the WooCommerce report MCP server, using its address and token from the environment.
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: process.env.WOO_MCP_URL!,
  description:
    "WooCommerce store reports: sales by period, order counts by status, product counts by type, customer counts, and coupon counts.",
  headers: { Authorization: `Bearer ${process.env.WOO_MCP_TOKEN}` },
});