// Event BeeworkEscrow yang diindeks GhostGraph. Harus identik dengan kontrak.
interface Events {
    event BountyFunded(
        bytes32 indexed bountyId,
        bytes32 indexed taskId,
        address indexed creator,
        address reviewer,
        address asset,
        uint256 budget,
        uint256 fee,
        uint64 deadline,
        uint64 refundAt,
        uint32 maxWinners
    );
    event RewardAllocated(
        bytes32 indexed bountyId,
        bytes32 indexed submissionId,
        address indexed winner,
        address asset,
        uint256 reward,
        uint256 fee
    );
    event BountyRefunded(bytes32 indexed bountyId, address indexed creator, address indexed asset, uint256 amount);
    event Withdrawn(address indexed account, address indexed asset, address indexed recipient, uint256 amount);
}
