import * as fs from 'fs'

let x = 0
let y = 0

const lines = fs.readFileSync('src/inputs/two.txt')
.toString()
.split('\n')


function calculatePosition(lines: string[]) {
    for (const line of lines) {
        const [dir, move] = line.split(' ')
        switch (dir) {
            case 'up':
                y-=parseInt(move)
                break;
            case 'down':
                y+=parseInt(move)
                break
            case 'forward':
                x+=parseInt(move)
                break
        }
    }
    return x*y
}

function calculatePositionByAim(lines: string[]) {
    let x = 0
    let y = 0
    let aim = 0
    for (const line of lines) {
        const [dir, move] = line.split(' ')
        switch (dir) {
            case 'up':
                aim-=parseInt(move)
                break;
            case 'down':
                aim+=parseInt(move)
                break
            case 'forward':
                x+=parseInt(move)
                y+=parseInt(move) * aim
                break
        }
    }
    return x*y
}


console.log(calculatePosition(lines))
console.log(calculatePositionByAim(lines))