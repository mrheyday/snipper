#!/bin/bash
set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Display header
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║   ARBITRUM SNIPER BOT - DEPLOYMENT HELPER SCRIPT          ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Function to display usage
usage() {
  echo -e "${YELLOW}Usage: $0 [OPTIONS]${NC}"
  echo ""
  echo "Options:"
  echo "  -n, --network NETWORK    Network to deploy to (arbitrum|sepolia)"
  echo "  -v, --verify             Verify contracts on Etherscan after deployment"
  echo "  -d, --dry-run            Perform dry-run (no actual deployment)"
  echo "  -h, --help               Display this help message"
  echo ""
  echo "Examples:"
  echo "  # Dry-run on Arbitrum Sepolia"
  echo "  $0 --network sepolia --dry-run"
  echo ""
  echo "  # Deploy to Arbitrum Sepolia with verification"
  echo "  $0 --network sepolia --verify"
  echo ""
  echo "  # Deploy to Arbitrum mainnet"
  echo "  $0 --network arbitrum"
  echo ""
}

# Default values
NETWORK="sepolia"
VERIFY=false
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -n|--network)
      NETWORK="$2"
      shift 2
      ;;
    -v|--verify)
      VERIFY=true
      shift
      ;;
    -d|--dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      usage
      exit 1
      ;;
  esac
done

# Validate network
if [[ ! "$NETWORK" =~ ^(arbitrum|sepolia)$ ]]; then
  echo -e "${RED}Error: Invalid network '$NETWORK'. Must be 'arbitrum' or 'sepolia'${NC}"
  exit 1
fi

# Check .env file
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo -e "${RED}Error: .env file not found in $PROJECT_DIR${NC}"
  echo -e "${YELLOW}Please copy .env.example to .env and fill in the values:${NC}"
  echo "  cp $PROJECT_DIR/.env.example $PROJECT_DIR/.env"
  exit 1
fi

# Load environment variables
set -a
source "$PROJECT_DIR/.env"
set +a

# Verify required environment variables
required_vars=("PRIVATE_KEY")
for var in "${required_vars[@]}"; do
  if [[ -z "${!var}" ]]; then
    echo -e "${RED}Error: $var is not set in .env${NC}"
    exit 1
  fi
done

# Select RPC URL based on network
case $NETWORK in
  arbitrum)
    RPC_URL="${ARBITRUM_RPC_URL:-https://arb1.arbitrum.io/rpc}"
    CHAIN_NAME="Arbitrum One (Mainnet)"
    CHAIN_ID=42161
    ;;
  sepolia)
    RPC_URL="${ARBITRUM_SEPOLIA_RPC_URL:-https://sepolia-rollup.arbitrum.io:443}"
    CHAIN_NAME="Arbitrum Sepolia (Testnet)"
    CHAIN_ID=421614
    ;;
esac

# Validate RPC URL
if [[ -z "$RPC_URL" ]]; then
  echo -e "${RED}Error: RPC URL not configured for $NETWORK${NC}"
  exit 1
fi

# Display configuration
echo -e "${BLUE}Configuration:${NC}"
echo "  Network:      $CHAIN_NAME (Chain ID: $CHAIN_ID)"
echo "  RPC URL:      $RPC_URL"
echo "  Script:       Deploy.s.sol"
if [[ "$DRY_RUN" == true ]]; then
  echo "  Mode:         DRY-RUN (no actual deployment)"
fi
if [[ "$VERIFY" == true ]]; then
  echo "  Verify:       Yes (post-deployment)"
fi
echo ""

# Build deployment command
DEPLOY_CMD="forge script script/Deploy.s.sol --rpc-url $RPC_URL"

if [[ "$DRY_RUN" == true ]]; then
  echo -e "${YELLOW}Running dry-run deployment...${NC}"
  DEPLOY_CMD="$DEPLOY_CMD"
else
  echo -e "${YELLOW}Broadcasting deployment transaction...${NC}"
  DEPLOY_CMD="$DEPLOY_CMD --broadcast"

  if [[ "$VERIFY" == true ]]; then
    echo -e "${YELLOW}Contracts will be verified post-deployment${NC}"
    DEPLOY_CMD="$DEPLOY_CMD --verify"
  fi
fi

echo ""

# Execute deployment
cd "$PROJECT_DIR"
if eval "$DEPLOY_CMD"; then
  echo ""
  echo -e "${GREEN}✅ Deployment successful!${NC}"
  echo ""
  echo "📝 Next steps:"
  echo "  1. Save the contract addresses from output above"
  echo "  2. Update your .env file with the new addresses:"
  echo "     SNIPER_SEARCHER_ADDRESS=0x..."
  echo "     FLASH_LOAN_RECEIVER_ADDRESS=0x..."
  echo "     DELEGATED_EXECUTOR_ADDRESS=0x..."
  echo "  3. Run verification: $0 --network $NETWORK --verify"
  echo "  4. Run integration tests against deployed contracts"
  echo "  5. Monitor initial transactions carefully"
  echo ""

  if [[ "$DRY_RUN" == false ]]; then
    echo -e "${BLUE}View transaction on Arbiscan:${NC}"
    if [[ "$NETWORK" == "arbitrum" ]]; then
      echo "  https://arbiscan.io/tx/<TX_HASH>"
    else
      echo "  https://sepolia.arbiscan.io/tx/<TX_HASH>"
    fi
    echo ""
  fi
else
  echo ""
  echo -e "${RED}❌ Deployment failed!${NC}"
  echo "Check the error message above and retry."
  exit 1
fi
