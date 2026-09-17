import { config } from "../src/lib/config";
console.log(
  JSON.stringify({
    event: "configuration_validated",
    network: config.ARK_NETWORK,
    adapter: config.ARK_ADAPTER,
  }),
);
