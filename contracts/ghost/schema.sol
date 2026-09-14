// Satu baris per event (log datar) — inilah yang ditarik backend Beework.
struct EscrowEvent {
    string id;              // details.uniqueId()
    string kind;            // BountyFunded | RewardAllocated | BountyRefunded | Withdrawn
    bytes32 bountyId;
    bytes32 taskId;
    bytes32 submissionId;
    address creator;
    address reviewer;
    address winner;
    address account;
    address recipient;
    address asset;
    uint256 amount;         // budget | reward | amount
    uint256 fee;
    uint64 deadline;
    uint64 refundAt;
    uint32 maxWinners;
    uint64 block;
    uint32 logIndex;
    bytes32 transactionHash;
    uint32 timestamp;
}

// Keadaan bounty terkini — untuk konsumen GraphQL yang tidak mau replay event.
struct Bounty {
    bytes32 id;             // bountyId
    bytes32 taskId;
    address creator;
    address reviewer;
    address asset;
    uint256 budget;
    uint256 fee;
    uint256 awarded;
    uint256 feeCharged;
    uint32 maxWinners;
    uint32 winners;
    uint64 deadline;
    uint64 refundAt;
    bool closed;
    bool refunded;
    uint64 fundedBlock;
}

// Agregat per wallet per aset.
struct WalletAsset {
    string id;              // wallet-asset
    address wallet;
    address asset;
    uint256 funded;         // total yang pernah dikunci sebagai creator
    uint256 awarded;        // total reward yang diterima
    uint256 refunded;
    uint256 withdrawn;
}
