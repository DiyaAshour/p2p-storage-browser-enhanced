import { ethers } from 'ethers';

interface WalletState {
  address: string | null;
  balance: string;
  isConnected: boolean;
  chainId: number | null;
}

class Web3Service {
  private provider: ethers.BrowserProvider | null = null;
  private signer: ethers.Signer | null = null;
  private walletState: WalletState = {
    address: null,
    balance: '0',
    isConnected: false,
    chainId: null,
  };

  async connectWallet(): Promise<WalletState> {
    try {
      if (!window.ethereum) {
        throw new Error('MetaMask is not installed');
      }

      // Request account access
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts',
      });

      if (accounts.length === 0) {
        throw new Error('No accounts found');
      }

      // Initialize provider and signer
      this.provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await this.provider.getSigner();

      // Get wallet info
      const address = accounts[0];
      const balance = await this.provider.getBalance(address);
      const network = await this.provider.getNetwork();

      this.walletState = {
        address,
        balance: ethers.formatEther(balance),
        isConnected: true,
        chainId: Number(network.chainId),
      };

      // Listen for account changes
      window.ethereum.on('accountsChanged', (newAccounts: string[]) => {
        if (newAccounts.length === 0) {
          this.disconnectWallet();
        } else {
          this.walletState.address = newAccounts[0];
        }
      });

      // Listen for chain changes
      window.ethereum.on('chainChanged', () => {
        window.location.reload();
      });

      return this.walletState;
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      throw error;
    }
  }

  disconnectWallet(): void {
    this.walletState = {
      address: null,
      balance: '0',
      isConnected: false,
      chainId: null,
    };
    this.provider = null;
    this.signer = null;
  }

  getWalletState(): WalletState {
    return this.walletState;
  }

  async getBalance(): Promise<string> {
    if (!this.provider || !this.walletState.address) {
      throw new Error('Wallet not connected');
    }

    const balance = await this.provider.getBalance(this.walletState.address);
    return ethers.formatEther(balance);
  }

  async signMessage(message: string): Promise<string> {
    if (!this.signer) {
      throw new Error('Signer not available');
    }

    return await this.signer.signMessage(message);
  }

  // Payment system: Calculate cost based on storage size
  calculateStorageCost(sizeInTB: number): number {
    // 1 dollar per 1 TB per month
    return sizeInTB * 1;
  }

  // Create payment transaction
  async createPaymentTransaction(
    recipientAddress: string,
    amountInUSD: number
  ): Promise<string> {
    if (!this.signer) {
      throw new Error('Signer not available');
    }

    try {
      // Convert USD to ETH (you would need to use an oracle for real conversion)
      // For now, we'll use a fixed rate (1 USD = 0.0005 ETH as example)
      const ethAmount = amountInUSD * 0.0005;

      const tx = await this.signer.sendTransaction({
        to: recipientAddress,
        value: ethers.parseEther(ethAmount.toString()),
      });

      return tx.hash;
    } catch (error) {
      console.error('Failed to create payment transaction:', error);
      throw error;
    }
  }

  // Verify payment signature
  async verifySignature(
    message: string,
    signature: string,
    address: string
  ): Promise<boolean> {
    try {
      const recoveredAddress = ethers.verifyMessage(message, signature);
      return recoveredAddress.toLowerCase() === address.toLowerCase();
    } catch (error) {
      console.error('Failed to verify signature:', error);
      return false;
    }
  }
}

export const web3Service = new Web3Service();

// Extend window interface for TypeScript
declare global {
  interface Window {
    ethereum?: any;
  }
}
