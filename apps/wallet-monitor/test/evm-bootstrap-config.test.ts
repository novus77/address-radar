import { describe, expect, it } from "vitest";
import { loadWalletMonitorConfig } from "../src/config.js";

const base = { RADAR_RPC_BSC_HTTP_URL: "https://bsc.example" };
const config = (value: string) => loadWalletMonitorConfig({ ...base, ADDRESS_RADAR_EVM_BOOTSTRAP_FLOORS: value });

describe("sealed EVM bootstrap floor configuration", () => {
  it("does not infer floors when absent, preserving legacy configuration", () => {
    expect(loadWalletMonitorConfig(base).evmBootstrapFloors).toEqual({});
  });

  it("accepts only an explicit frozen chain map of positive safe integers", () => {
    const floors = config('{"eth":1,"bsc":126000000,"base":35000000}').evmBootstrapFloors;
    expect(floors).toEqual({ eth: 1, bsc: 126000000, base: 35000000 });
    expect(Object.isFrozen(floors)).toBe(true);
    expect(config('{"bsc":1}').evmBootstrapFloors).toEqual({ bsc: 1 });
    expect(config('{}').evmBootstrapFloors).toEqual({});
  });

  it.each(['', ' ', 'null', '[]', '1', '"map"', '{', '{"solana":1}', '{"robinhood":1}', '{"BSC":1}',
    '{"bsc":0}', '{"bsc":-1}', '{"bsc":1.5}', '{"bsc":"10"}', '{"bsc":null}', '{"bsc":true}',
    '{"bsc":{}}', '{"bsc":9007199254740992}', '{"bsc":1e309}', '{"__proto__":1}',
    '{"bsc":1,"bsc":2}', '{"bsc":1,"b\\u0073c":2}', ' '.repeat(4097)])("rejects invalid or ambiguous sealed material: %s", value => {
    expect(() => config(value)).toThrow("Invalid sealed EVM bootstrap floors");
  });
});
