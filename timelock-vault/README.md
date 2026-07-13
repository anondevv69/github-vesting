# TimeLockVault

Trustless time-based ERC-20 locker for Robinhood Chain (and any EVM chain).  
Lock tokens for a fixed duration — no admin, no early release, no oracle.

Each lock mints an **ERC-721 NFT** (`TLV`) with on-chain animated SVG metadata.  
NFT ownership = withdrawal rights until claimed.

Designed by [Bankr](https://bankr.bot). Deployed standalone from [Proof of Dev](https://www.proofofdev.xyz).

## Deployed (Robinhood mainnet, chain 4663)

| | |
|---|---|
| **Contract** | [`0xeFC8591519a2D8885C1b62C7de84ce906F22Fa78`](https://robinhoodchain.blockscout.com/address/0xeFC8591519a2D8885C1b62C7de84ce906F22Fa78) |
| **Explorer** | [Blockscout](https://robinhoodchain.blockscout.com/address/0xeFC8591519a2D8885C1b62C7de84ce906F22Fa78) |
| **Verified** | Yes (source on Blockscout) |

## How it works

```
deposit(token, amount, lockTime)  →  tokens in vault + NFT minted
         ↓ (wait lockTime seconds)
withdraw(lockId)                  →  tokens to NFT owner, NFT burned
```

- **`extendLock(lockId, additionalSec)`** — only adds time (never shortens)
- **No constructor args** — fully permissionless, no owner

### Improvements over original Bankr draft

- Reverts on invalid `lockId` in view functions
- `extendLock` blocked after withdrawal
- Zero-address token rejected
- Overflow guard on `unlockTime`
- NFT **burned** on withdraw (no dead tradable claims)
- Fixed address short-format in metadata (`0xAbCd...1234`)
- Transfer-before-state in `deposit` (tokens in vault before NFT mint)

## Compile & deploy

From repo root (uses parent `node_modules`):

```bash
cd timelock-vault
npx hardhat compile
npx hardhat run scripts/deploy.ts --network robinhood
```

Requires `ORACLE_PRIVATE_KEY` (or any deployer key) and `ROBINHOOD_RPC_URL` in parent `.env`.

### Compiler settings

| Setting | Value |
|---|---|
| Solidity | `0.8.24` |
| Optimizer | 200 runs |
| via-IR | **required** |
| EVM | `cancun` |

### Verify on Blockscout

```bash
npx hardhat verify --network robinhood <DEPLOYED_ADDRESS>
```

No constructor arguments.

## Remix deploy

1. Copy `contracts/TimeLockVault.sol` into Remix
2. Compiler **0.8.24**, optimizer **200**, **via-IR** on, EVM **cancun**
3. Deploy with MetaMask on Robinhood Chain (chain ID **4663**)
4. RPC: `https://rpc.mainnet.chain.robinhood.com`

## Example: lock 420 days

```solidity
// 1. approve vault
IERC20(token).approve(vault, amount);

// 2. lock (420 days = 36_288_000 seconds)
uint256 lockId = vault.deposit(token, amount, 36_288_000);

// 3. after unlockTime — only NFT holder can withdraw
vault.withdraw(lockId);
```

## License

MIT
