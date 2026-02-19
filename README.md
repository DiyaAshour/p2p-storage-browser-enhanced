# P2P Decentralized Storage Browser

A peer-to-peer decentralized file storage application built with Electron, React, and Web3 technologies. This application allows users to store files on a distributed network, with payment processing via cryptocurrency wallets.

## Features

- **Web3 Wallet Integration**: Connect MetaMask or other Web3 wallets
- **P2P File Sharing**: Distribute files across a peer-to-peer network using libp2p
- **Decentralized Storage**: Store files locally with distributed backup
- **Payment System**: Pay for storage using cryptocurrency ($1 per 1TB per month)
- **File Indexing**: Make files discoverable on the network or keep them private
- **File Search**: Search for files by name or hash across the network
- **Desktop Application**: Built with Electron for cross-platform support

## System Requirements

- Node.js 18+ and npm/pnpm
- MetaMask browser extension (for Web3 wallet integration)
- 2GB RAM minimum
- 500MB disk space

## Installation

### 1. Clone the Repository

```bash
git clone <repository-url>
cd p2p-storage-browser
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Environment Setup

Create a `.env.local` file in the project root:

```env
VITE_APP_TITLE=P2P Storage Browser
VITE_APP_ID=p2p-storage-browser
VITE_FRONTEND_FORGE_API_URL=http://localhost:3000
```

## Development

### Start Development Server

For web development:

```bash
pnpm run dev
```

This starts the Vite development server on `http://localhost:3000`.

### Start Electron App (Desktop)

In a separate terminal:

```bash
pnpm run dev:electron
```

This will start both the Vite dev server and the Electron application.

### Build for Production

```bash
pnpm run build:electron
```

This creates a distributable Electron application.

## Usage

### 1. Connect Your Wallet

1. Click "Connect Wallet" button
2. Approve the connection in MetaMask
3. Your wallet address and balance will be displayed

### 2. Upload Files

1. Go to the "Upload Files" tab
2. Select files from your computer
3. Optionally check "Index files for network search" to make files discoverable
4. Click "Upload Files"

### 3. Browse Files

1. Go to the "File Browser" tab
2. View all uploaded files
3. Download files by clicking the download icon
4. Delete files by clicking the trash icon

### 4. Search Files

1. Use the search bar to find files by name or hash
2. Results are displayed in real-time

### 5. Manage Storage

1. Go to the "Statistics" tab
2. View storage usage and costs
3. Upgrade storage by selecting a plan (1TB, 3TB, 5TB, 10TB)

## Architecture

### Frontend Structure

```
client/
├── src/
│   ├── pages/           # Page components
│   │   └── Home.tsx     # Main application page
│   ├── components/      # Reusable UI components
│   ├── hooks/           # Custom React hooks
│   │   ├── useWallet.ts # Wallet management
│   │   └── useStorage.ts # Storage management
│   ├── services/        # Business logic services
│   │   ├── web3Service.ts    # Web3 and MetaMask integration
│   │   ├── p2pService.ts     # P2P networking
│   │   └── storageService.ts # Local file storage
│   ├── App.tsx          # Root component
│   └── index.css        # Global styles
├── public/              # Static assets
└── index.html           # HTML entry point
```

### Backend Structure

```
electron/
├── main.js              # Electron main process
└── preload.js           # Preload script for IPC
```

## Key Technologies

- **React 19**: UI framework
- **Electron 28**: Desktop application framework
- **ethers.js 6**: Web3 library for wallet integration
- **libp2p**: P2P networking protocol
- **Tailwind CSS 4**: Styling
- **shadcn/ui**: UI component library
- **IndexedDB**: Client-side storage

## Payment System

The application uses a simple payment model:

- **1 TB Storage**: $1/month
- **3 TB Storage**: $3/month
- **5 TB Storage**: $5/month
- **10 TB Storage**: $10/month

Payments are processed through cryptocurrency transactions using the connected wallet.

## P2P Network

The application uses libp2p for peer-to-peer networking:

- **Peer Discovery**: Automatic peer discovery using DHT
- **File Distribution**: Files are distributed across connected peers
- **Network Resilience**: Files remain available as long as at least one peer is online
- **Indexing**: Optional file indexing for network-wide search

## Security

- **Wallet Integration**: Uses MetaMask for secure key management
- **Message Signing**: Sign messages with your private key for authentication
- **Encryption**: Files can be encrypted before upload
- **Sandbox Mode**: Electron runs in sandbox mode for security

## Troubleshooting

### MetaMask Connection Issues

1. Ensure MetaMask is installed and unlocked
2. Check that you're on the correct network
3. Try disconnecting and reconnecting

### File Upload Issues

1. Check available disk space
2. Ensure files are not too large (max 4GB per file)
3. Check network connectivity

### P2P Network Issues

1. Ensure ports are not blocked by firewall
2. Check that other peers are online
3. Restart the application

## API Reference

### useWallet Hook

```typescript
const {
  address,
  balance,
  isConnected,
  chainId,
  isLoading,
  error,
  connect,
  disconnect,
  refreshBalance,
} = useWallet();
```

### useStorage Hook

```typescript
const {
  files,
  quota,
  isLoading,
  error,
  uploadFile,
  downloadFile,
  deleteFile,
  searchFiles,
  setStorageQuota,
  refreshFiles,
} = useStorage();
```

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:

1. Check the troubleshooting section
2. Open an issue on GitHub
3. Contact the development team

## Roadmap

- [ ] Smart contract integration for automated payments
- [ ] File encryption and decryption
- [ ] IPFS integration for distributed storage
- [ ] Multi-chain wallet support
- [ ] Mobile application
- [ ] Advanced file versioning
- [ ] Collaborative file sharing
- [ ] Network statistics dashboard

## Disclaimer

This is a beta application. Use at your own risk. Always backup important files before uploading to the network.
