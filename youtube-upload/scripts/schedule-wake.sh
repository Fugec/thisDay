#!/bin/bash
# Schedules upcoming Mac wake events to match the social cron times.
# Run once to bootstrap, then social-cron.js calls this at the end of each
# run to keep the schedule rolling forward automatically.
#
# Wake times (UTC): 13:00 and 15:00, Mon/Tue/Thu/Fri (days 1,2,4,5)
# Mac wakes 5 min early, cron fires at :05, Mac returns to sleep on idle.
#
# Usage:
#   sudo bash scripts/schedule-wake.sh

set -e

# Days of week that need wakes (1=Mon,2=Tue,4=Thu,5=Fri)
WAKE_DAYS=(1 2 4 5)
# Wake 5 min before cron fires so system is fully up
WAKE_TIMES=("12:58:00" "14:58:00")

NOW=$(date -u +%s)

# Clear existing pmset-scheduled wakes before re-adding
pmset schedule cancelall "pmset" 2>/dev/null || true

for WTIME in "${WAKE_TIMES[@]}"; do
  for DOW in "${WAKE_DAYS[@]}"; do
    CUR_DOW=$(date -u +%w)
    DAYS_AHEAD=$(( (DOW - CUR_DOW + 7) % 7 ))

    TARGET_DATE=$(date -u -v+${DAYS_AHEAD}d +%Y-%m-%d)
    TARGET_DT="${TARGET_DATE} ${WTIME}"
    TARGET_EPOCH=$(date -u -j -f "%Y-%m-%d %H:%M:%S" "$TARGET_DT" +%s 2>/dev/null)

    # If already passed, push to next week
    if [ "$TARGET_EPOCH" -le "$NOW" ]; then
      TARGET_DATE=$(date -u -v+$(( DAYS_AHEAD + 7 ))d +%Y-%m-%d)
      TARGET_DT="${TARGET_DATE} ${WTIME}"
    fi

    PMSET_DT=$(date -u -j -f "%Y-%m-%d %H:%M:%S" "$TARGET_DT" +"%m/%d/%y %H:%M:%S" 2>/dev/null)
    echo "Scheduling wake: $PMSET_DT UTC"
    pmset schedule wake "$PMSET_DT"
  done
done

echo "Done. Run 'pmset -g sched' to verify."
