# Turn classification control

The owner can say "turn classification off", "turn classification back on", or "is the classification pass on?" Amy must call `turn_classifier` with `off`, `on`, or `status` before confirming.

The saved setting `turnClassifierEnabled` defaults to true. A change applies from the next turn and persists across restarts. When off, the preliminary planning model call is skipped and the main reply model chooses from the permitted tools directly. The classification implementation remains installed and the control tool stays available. Memory extraction, profile learning, inner monologue, and autonomous research are separate settings. Tool permissions still apply in both modes.

Turn logs include `routingMode` and `classifierMs` for verification. Loading a code update requires the normal manual restart; changing the setting afterward does not.
