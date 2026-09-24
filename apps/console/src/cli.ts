import { createAddressConsoleApplication } from "./application.js";
import { startAddressRadarConsole } from "./server.js";

const application = createAddressConsoleApplication(
  process.env.ADDRESS_RADAR_DATABASE_PATH ?? ".address-radar/address-radar.sqlite",
);
const server = await startAddressRadarConsole({
  application,
  host: process.env.ADDRESS_RADAR_CONSOLE_HOST ?? "127.0.0.1",
  port: Number(process.env.ADDRESS_RADAR_CONSOLE_PORT ?? "3211"),
});

console.log(`Address Radar developer console listening on ${server.url}`);
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exitCode = 0;
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
