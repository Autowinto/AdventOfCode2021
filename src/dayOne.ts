import * as fs from 'fs'

const lines = fs
  .readFileSync('src/inputs/one.txt')
  .toString()
  .split('\n')
  .map((item) => {
    return parseInt(item)
  })

function getTimesIncreased(lines: number[]): number {
  let prevNumber = 0
  let timesIncreased = 0

  for (const line of lines) {
    const number = line
    if (prevNumber && number > prevNumber) {
      timesIncreased++
    }
    prevNumber = number
  }

  return timesIncreased
}

function getSlidingWindowIncreases(lines: number[]) {
  let prevSum = 0
  let timesIncreased = 0

  for (const [idx] of lines.entries()) {
    const sum = lines[idx] + lines[idx + 1] + lines[idx + 2]
    if (prevSum && sum > prevSum) {
      timesIncreased++
    }
    prevSum = sum
  }

  return timesIncreased
}

console.log(getTimesIncreased(lines))
console.log(getSlidingWindowIncreases(lines))
