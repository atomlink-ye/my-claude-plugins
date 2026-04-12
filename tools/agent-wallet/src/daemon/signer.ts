import { createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type MessageToSign = string | { raw: Hex };

export interface TypedDataParameter {
  domain?: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export class Signer {
  private readonly account;

  constructor(privateKey: `0x${string}`) {
    this.account = privateKeyToAccount(privateKey);
  }

  getAddress(): Address {
    return this.account.address;
  }

  async signMessage(message: MessageToSign): Promise<Hex> {
    return this.account.signMessage({ message });
  }

  async signTypedData(typedData: TypedDataParameter): Promise<Hex> {
    return this.account.signTypedData(typedData as never);
  }

  async signTransaction(transaction: Record<string, unknown>): Promise<Hex> {
    return this.account.signTransaction(transaction as never);
  }

  async sendTransaction(transaction: Record<string, unknown>, rpcUrl: string): Promise<Hex> {
    const walletClient = createWalletClient({
      account: this.account,
      transport: http(rpcUrl),
    });

    return walletClient.sendTransaction(transaction as never);
  }
}
