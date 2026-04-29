#!/bin/bash
# Schedules upcoming Mac wake events to match the social cron times.
# Run once to bootstrap, then social-cron.js calls this at the end of each
# run to keep the schedule rolling forward automatically.
#
# Wake times (UTC): 02:35 and 03:35, Mon/Tue/Thu/Fri (days 1,2,4,5)
# Mac wakes 2 min early, cron fires at :35, Mac returns to sleep on idle.
WAKE_TIMES=("02:35:00" "03:35:00")
WAKE_DAYS=(1 2 4 5)

NOW=$(date -u +%s)

# Clear all existing pmset-scheduled wake events before re-adding
pmset schedule cancelall 2>/dev/null || true

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
