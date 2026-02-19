import { useState, useCallback, useEffect } from 'react';
import { web3Service } from '@/services/web3Service';

export interface WalletState {
  address: string | null;
  balance: string;
  isConnected: boolean;
  chainId: number | null;
  isLoading: boolean;
  error: string | null;
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    balance: '0',
    isConnected: false,
    chainId: null,
    isLoading: false,
    error: null,
  });

  const connect = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const walletState = await web3Service.connectWallet();
      setState({
        address: walletState.address,
        balance: walletState.balance,
        isConnected: walletState.isConnected,
        chainId: walletState.chainId,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error:
          error instanceof Error ? error.message : 'Failed to connect wallet',
      }));
    }
  }, []);

  const disconnect = useCallback(() => {
    web3Service.disconnectWallet();
    setState({
      address: null,
      balance: '0',
      isConnected: false,
      chainId: null,
      isLoading: false,
      error: null,
    });
  }, []);

  const refreshBalance = useCallback(async () => {
    try {
      const balance = await web3Service.getBalance();
      setState((prev) => ({ ...prev, balance }));
    } catch (error) {
      console.error('Failed to refresh balance:', error);
    }
  }, []);

  useEffect(() => {
    // Check if wallet is already connected
    const checkConnection = async () => {
      if (typeof window !== 'undefined' && window.ethereum) {
        try {
          const accounts = await window.ethereum.request({
            method: 'eth_accounts',
          });
          if (accounts.length > 0) {
            await connect();
          }
        } catch (error) {
          console.error('Failed to check wallet connection:', error);
        }
      }
    };

    checkConnection();
  }, [connect]);

  return {
    ...state,
    connect,
    disconnect,
    refreshBalance,
  };
}
