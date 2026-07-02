class Encounter {

  int Rank;    //Switch Encounters
  float PreyX;
  float PreyY;

  float r;  //collider radius

  int Speed=4;  //Encounter Speed

  boolean PreyAtk = false;

  //Counters and Switches//
  int CountSwitch;
  int CountDying;
  int CountDive;
  int TakeHealth;


  Encounter (float X, float Y, int R) {

    PreyX = X;
    PreyY = Y;
    Rank = R;
    r=65;
    CountSwitch=0;
    CountDying=0;
    CountDive=0;
    TakeHealth= 0;
  }


  // Display faded ellipses depending on rank
  void dispRank(Player PlayerNum) {
    if (Rank<PlayerNum.RankPlayer && Rank != -1 && Rank != -2  && Rank<100)
      FadedEllipse(PreyX, PreyY, Blue, 1);
    else if (Rank>=PlayerNum.RankPlayer && Rank<100)
      FadedEllipse(PreyX, PreyY, Purple, 1);
  }

  //Display Encounters//
  void display() {
    if (PreyY<=height+40 && PreyY >-40) { //display Encounters only in the screen
      noFill();
      stroke(2);

      //circle(PreyX, PreyY, r);    //Collider circle

      imageMode(CENTER);
      switch(Rank) {

      case 0:    //Worm      
        if (!PreyAtk) {    //Idle
          image(Shadow, PreyX, PreyY);   
          image(WormIdle, PreyX, PreyY);
        } else if (PreyAtk) {
          image(Shadow, PreyX, PreyY);   
          image( WormAttack, PreyX, PreyY);
          CountSwitch++; 
          if (CountSwitch==1)
            SoundWorm.play();
          if (CountSwitch==30)     //Attack until
            PreyAtk=false;
        }
        break;

      case 1:    //Spider
        if (!PreyAtk) {    //Idle
          image(Shadow, PreyX, PreyY);  
          image(SpiderIdle, PreyX, PreyY);
        } else if (PreyAtk) {
          image(Shadow, PreyX, PreyY);  
          image(SpiderAttack, PreyX, PreyY);
          SpiderAttack.play();
          CountSwitch++; 

          if (CountSwitch==1)
            SoundSpider.play();
          if (CountSwitch==30)     //Attack until
            PreyAtk=false;
        }
        break;

      case 2: //Bug

        if (!PreyAtk) {    //Idle
          image(Shadow, PreyX, PreyY);  
          image(BugIdle, PreyX, PreyY);
        } else if (PreyAtk) {
          image(Shadow, PreyX, PreyY);  
          image(BugAttack, PreyX, PreyY);
          BugAttack.play();
          CountSwitch++; 
          if (CountSwitch==1)
            SoundBug.play();
          if (CountSwitch==30)     //Attack until
            PreyAtk=false;
        }
        break;

      case 100:    //Rock
        image(Shadow, PreyX, PreyY); 
        image(Rock, PreyX, PreyY);
        if (PreyAtk) {
          //Attack latency
          CountSwitch++;
          if (CountSwitch==1) {
            SoundRock.play();
            PreyAtk=false;
          }
        }
        break;

      case 101:     //Cone
        image(Shadow, PreyX, PreyY); 
        image(Cone, PreyX, PreyY);
        if (PreyAtk) {
          //Attack latency
          CountSwitch++;
          if (CountSwitch==1) {
            SoundRock.play();
            PreyAtk=false;
          }
        }
        break;

      case -1:    //Dying
        FadedEllipse(PreyX, PreyY, Red, 1);
        image(Death, PreyX, PreyY);
        Death.play();
        CountSwitch++;
        if (CountSwitch>20) {
          Rank=-2;  //Died
          CountDying++;
        }
        break;

      case -2:  //Death
        PreyX=width/2;
        PreyY=-30;
        break;
      }
    }
  }
  void FadedEllipse(float X, float Y, color Color, int Size) {     //Rank Ellipses
    float  circleSize =Size *120;
    noStroke();
    for (int i = 0; i < circleSize; i = i+20*Size) {
      fill(Color, i);
      ellipse(X, Y+30, circleSize-i, (circleSize-i)/2);
    }
  }

  void Move() {
    PreyY-=Speed;
  }

  void Stop() {
    Speed=0;
  }

  //Moving Grounds//
  void GroundDisp() {
    imageMode(CENTER);
    for (int col=0; col<250; col++)  //Position Grounds
      for (int row=0; row<16; row++) {
        //rect(row*500, col*500, width/2, 500+PreyY);
        image(Ground, +row*200, col*200+PreyY);    //Display image
      }
  }
}
