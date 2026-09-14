// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Multi-asset escrow supporting native MON and allowlisted ERC-20 rewards.
/// @dev One bounty uses one immutable asset. address(0) represents native MON.
contract BeeworkEscrow is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE_MON = address(0);
    uint256 public constant FEE_BPS = 500;
    uint256 public constant REVIEW_PERIOD = 7 days;
    address public immutable feeRecipient;

    struct Bounty {
        address creator;
        address reviewer;
        address asset;
        uint64 refundAt;
        uint32 maxWinners;
        uint32 winners;
        bool closed;
        uint256 budget;
        uint256 awarded;
        uint256 feeCharged;
    }

    mapping(bytes32 => Bounty) public bounties;
    mapping(bytes32 => mapping(bytes32 => bool)) public paidSubmissions;
    mapping(bytes32 => mapping(address => bool)) public awardedWinners;
    mapping(address => bool) public allowedTokens;
    mapping(address => mapping(address => uint256)) public claimable;
    mapping(address => uint256) public totalLiability;

    error InvalidInput();
    error DuplicateBounty();
    error Unauthorized();
    error NotOpen();
    error RefundNotReady();
    error DuplicateAward();
    error InvalidAmount();
    error IncorrectDeposit();
    error TransferFailed();
    error AssetNotAllowed();
    error UnsupportedToken();

    event TokenPermissionUpdated(address indexed token, bool allowed);

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

    constructor(address admin, address treasury) Ownable(admin) {
        if (treasury == address(0)) revert InvalidInput();
        feeRecipient = treasury;
    }

    function bountyIdFor(address creator, bytes32 taskId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), creator, taskId));
    }

    function quoteFee(uint256 budget) public pure returns (uint256) {
        return Math.mulDiv(budget, FEE_BPS, 10_000);
    }

    function isAssetAllowed(address asset) public view returns (bool) {
        return asset == NATIVE_MON || allowedTokens[asset];
    }

    /// @notice Controls which ERC-20 assets may fund new bounties.
    /// @dev Disabling a token never blocks settlement of existing bounties.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == NATIVE_MON || (allowed && token.code.length == 0)) revert InvalidInput();
        allowedTokens[token] = allowed;
        emit TokenPermissionUpdated(token, allowed);
    }

    /// @param taskId keccak256(bytes(canonical lowercase backend task UUID)).
    function fund(bytes32 taskId, address reviewer, address asset, uint256 budget, uint64 deadline, uint32 maxWinners)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (bytes32 bountyId)
    {
        if (
            taskId == bytes32(0) || reviewer == address(0) || budget == 0 || maxWinners == 0
                || deadline <= block.timestamp || deadline > block.timestamp + 365 days
        ) revert InvalidInput();
        if (!isAssetAllowed(asset)) revert AssetNotAllowed();
        bountyId = bountyIdFor(msg.sender, taskId);
        if (bounties[bountyId].creator != address(0)) revert DuplicateBounty();
        uint256 fee = quoteFee(budget);
        uint256 deposit = budget + fee;
        if (asset == NATIVE_MON) {
            if (msg.value != deposit) revert IncorrectDeposit();
        } else {
            if (msg.value != 0) revert IncorrectDeposit();
            uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
            IERC20(asset).safeTransferFrom(msg.sender, address(this), deposit);
            if (IERC20(asset).balanceOf(address(this)) - beforeBalance != deposit) revert UnsupportedToken();
        }
        uint64 refundAt = deadline + uint64(REVIEW_PERIOD);
        bounties[bountyId] = Bounty(msg.sender, reviewer, asset, refundAt, maxWinners, 0, false, budget, 0, 0);
        totalLiability[asset] += deposit;
        emit BountyFunded(bountyId, taskId, msg.sender, reviewer, asset, budget, fee, deadline, refundAt, maxWinners);
    }

    /// @notice Allocates claimable funds. Only the reviewer chosen at funding can approve work.
    function award(bytes32 bountyId, bytes32 submissionId, address winner, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        Bounty storage b = bounties[bountyId];
        if (msg.sender != b.reviewer) revert Unauthorized();
        if (b.closed || block.timestamp >= b.refundAt) revert NotOpen();
        if (winner == address(0) || submissionId == bytes32(0)) revert InvalidInput();
        if (paidSubmissions[bountyId][submissionId] || awardedWinners[bountyId][winner]) revert DuplicateAward();
        if (amount == 0 || amount > b.budget - b.awarded || b.winners >= b.maxWinners) revert InvalidAmount();
        paidSubmissions[bountyId][submissionId] = true;
        awardedWinners[bountyId][winner] = true;
        b.winners++;
        b.awarded += amount;
        // Cumulative rounding prevents fee evasion by splitting awards.
        uint256 fee = quoteFee(b.awarded) - b.feeCharged;
        b.feeCharged += fee;
        claimable[b.asset][winner] += amount;
        claimable[b.asset][feeRecipient] += fee;
        if (b.awarded == b.budget) b.closed = true;
        emit RewardAllocated(bountyId, submissionId, winner, b.asset, amount, fee);
    }

    /// @notice Creator recovers only unallocated funds after deadline plus review period.
    /// @dev Available during pause. Already allocated winner funds cannot be refunded.
    function refund(bytes32 bountyId) external nonReentrant {
        Bounty storage b = bounties[bountyId];
        if (msg.sender != b.creator) revert Unauthorized();
        if (b.closed) revert NotOpen();
        if (block.timestamp < b.refundAt) revert RefundNotReady();
        b.closed = true;
        uint256 amount = b.budget - b.awarded + quoteFee(b.budget) - b.feeCharged;
        claimable[b.asset][b.creator] += amount;
        emit BountyRefunded(bountyId, b.creator, b.asset, amount);
    }

    /// @notice Pull payment; caller may redirect their own funds to another wallet.
    function withdraw(address asset, address recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidInput();
        uint256 amount = claimable[asset][msg.sender];
        if (amount == 0) revert InvalidAmount();
        claimable[asset][msg.sender] = 0;
        totalLiability[asset] -= amount;
        if (asset == NATIVE_MON) {
            (bool success,) = payable(recipient).call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
        emit Withdrawn(msg.sender, asset, recipient, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
